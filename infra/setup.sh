#!/usr/bin/env bash
# One-time AWS setup for security-rag. No Docker and no image push here -
# the container image is built and pushed by GitHub Actions, which also
# creates the Lambda function on its first successful run.
#
# Usage: bash infra/setup.sh --profile <name>
# Prerequisite: aws login --profile <name>
set -euo pipefail

PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$PROFILE" ]; then
  echo "usage: bash infra/setup.sh --profile <name>" >&2
  echo "run 'aws login --profile <name>' first" >&2
  exit 1
fi

AWS="aws --profile $PROFILE"
REGION="${AWS_REGION:-us-east-1}"
REPO="security-rag"
FUNC="security-rag"
GH_REPO="jon659/security-rag"
EXEC_ROLE="$FUNC-exec"
DEPLOY_ROLE="security-rag-deploy"

ACCOUNT=$($AWS sts get-caller-identity --query Account --output text --region "$REGION")
echo "account=$ACCOUNT region=$REGION profile=$PROFILE"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Preflight only: confirm the local .env carries the keys the deploy
# workflow will need as GitHub Actions secrets. This script never sends
# these values anywhere and never prints them, only whether they are
# present. Building and passing the actual Lambda environment happens in
# deploy.yml, sourced from GitHub secrets, not from this file - CI has no
# access to a local .env.
if [ -f .env ]; then
  FOUND_KEYS=$(node -e '
    const required = ["COHERE_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"];
    const dotenv = require("dotenv");
    const parsed = dotenv.config({ path: ".env" }).parsed || {};
    const vars = {};
    for (const key of required) {
      if (parsed[key]) vars[key] = parsed[key];
    }
    void JSON.stringify({ Variables: vars }); // built, never printed
    console.log(Object.keys(vars).join(","));
  ' 2>/dev/null || echo "")
  if [ -n "$FOUND_KEYS" ]; then
    echo "local .env has these keys ready to copy into GitHub secrets: $FOUND_KEYS"
  else
    echo "warning: local .env did not parse or has none of the required keys"
  fi
else
  echo "warning: no local .env found; you still need COHERE_API_KEY, ANTHROPIC_API_KEY, DATABASE_URL as GitHub secrets"
fi

# 1. ECR repository for the image
if $AWS ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1; then
  echo "ecr repository already exists"
else
  $AWS ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null
  echo "ecr repository created"
fi

# 2. Lambda execution role (assumed by the function itself at runtime)
cat > "$TMPDIR/lambda-trust.json" <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

if $AWS iam get-role --role-name "$EXEC_ROLE" >/dev/null 2>&1; then
  echo "exec role already exists"
else
  $AWS iam create-role --role-name "$EXEC_ROLE" --assume-role-policy-document "file://$TMPDIR/lambda-trust.json" >/dev/null
  echo "exec role created"
fi
$AWS iam attach-role-policy --role-name "$EXEC_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
EXEC_ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$EXEC_ROLE"
echo "exec role arn: $EXEC_ROLE_ARN"

# 3. GitHub OIDC provider, shared across any repo in this account, created
# once if it is not already there.
OIDC_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if $AWS iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "github oidc provider already exists"
else
  $AWS iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
  echo "github oidc provider created"
fi

# 4. Deploy role assumed by GitHub Actions via OIDC, trusted only for
# pushes to main of this one repository.
cat > "$TMPDIR/deploy-trust.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},"StringLike":{"token.actions.githubusercontent.com:sub":"repo:$GH_REPO:ref:refs/heads/main"}}}]}
EOF

cat > "$TMPDIR/deploy-policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["ecr:GetAuthorizationToken"],"Resource":"*"},
 {"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],"Resource":"arn:aws:ecr:$REGION:$ACCOUNT:repository/$REPO"},
 {"Effect":"Allow","Action":["lambda:CreateFunction","lambda:UpdateFunctionCode","lambda:UpdateFunctionConfiguration","lambda:GetFunction","lambda:CreateFunctionUrlConfig","lambda:GetFunctionUrlConfig","lambda:AddPermission"],"Resource":"arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNC"},
 {"Effect":"Allow","Action":["iam:PassRole"],"Resource":"$EXEC_ROLE_ARN"}
]}
EOF

if $AWS iam get-role --role-name "$DEPLOY_ROLE" >/dev/null 2>&1; then
  $AWS iam update-assume-role-policy --role-name "$DEPLOY_ROLE" --policy-document "file://$TMPDIR/deploy-trust.json"
  echo "deploy role already exists, trust policy refreshed"
else
  $AWS iam create-role --role-name "$DEPLOY_ROLE" --assume-role-policy-document "file://$TMPDIR/deploy-trust.json" >/dev/null
  echo "deploy role created"
fi
$AWS iam put-role-policy --role-name "$DEPLOY_ROLE" --policy-name deploy --policy-document "file://$TMPDIR/deploy-policy.json"
DEPLOY_ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$DEPLOY_ROLE"
echo "deploy role arn: $DEPLOY_ROLE_ARN"

echo
echo "Set these as GitHub repository variables (Settings, Secrets and variables, Actions, Variables tab):"
echo "  AWS_ACCOUNT_ID=$ACCOUNT"
echo "  AWS_REGION=$REGION"
echo "  LAMBDA_EXEC_ROLE_ARN=$EXEC_ROLE_ARN"
echo
echo "Set these as GitHub repository secrets (Actions, Secrets tab), from your own .env, never from this output:"
echo "  COHERE_API_KEY, ANTHROPIC_API_KEY, DATABASE_URL"
echo
echo "Nothing to do with $DEPLOY_ROLE_ARN by hand - deploy.yml assumes it automatically."
echo "The Lambda function itself does not exist yet. It is created on the first successful run of the deploy workflow."
