# Infra

The container image is built and pushed by GitHub Actions, not on a developer machine, because
this machine has no hypervisor and cannot run Docker locally. `infra/setup.sh` only creates the
AWS-side plumbing that GitHub Actions needs; it never builds or pushes an image.

## One-time owner setup

1. Log in with a named AWS CLI profile (not the root user):

   ```bash
   aws login --profile security-rag
   ```

   (If your CLI version does not have `aws login`, use `aws configure --profile security-rag` or
   `aws sso login --profile security-rag` instead, whichever matches how the profile was set up.)

2. Run the setup script with that profile:

   ```bash
   bash infra/setup.sh --profile security-rag
   ```

   This creates, or confirms already exists:

   - the `security-rag` ECR repository
   - the `security-rag-exec` Lambda execution role (`AWSLambdaBasicExecutionRole`)
   - the GitHub OIDC provider for `token.actions.githubusercontent.com`, shared across any repo
     in the account
   - the `security-rag-deploy` role, trusted only by pushes to `main` of `jon659/security-rag`,
     with a policy scoped to pushing the one ECR repository and managing the one Lambda function

   It does not create the Lambda function. There is no image to point it at yet. The function is
   created automatically the first time the deploy workflow runs successfully.

3. Set the three values the script prints as GitHub repository variables:
   `Settings > Secrets and variables > Actions > Variables tab`

   - `AWS_ACCOUNT_ID`
   - `AWS_REGION`
   - `LAMBDA_EXEC_ROLE_ARN`

4. Set these as GitHub repository secrets (same page, `Secrets` tab), copied from your own local
   `.env`, never pasted from anything this script prints:

   - `COHERE_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `DATABASE_URL`

5. Push to `main`. Watch the `ci` workflow finish, then `deploy` start automatically after it.
   On the first run, `deploy` builds the image, pushes it to ECR, creates the Lambda function
   with a public function URL, and checks `/health`. On every later run it just updates the
   function's code.

6. Copy the function URL that `deploy` prints in its job summary and paste it into the Status
   section of the repository's top-level `README.md`.

## Re-running setup.sh

The script is idempotent: rerun it any time (for example after rotating the OIDC provider or if
a role's policy drifted) and it will skip anything that already exists, and refresh the deploy
role's trust and inline policy either way.

## What never leaves this machine

`infra/setup.sh` reads your local `.env` only to confirm the three required keys are present.
It never prints their values and never sends them to AWS. The Lambda function's actual runtime
environment is built by `deploy.yml` from the GitHub Actions secrets you set in step 4, not from
this file.

Note: the three values above may be stored either as repository variables or as repository secrets; the deploy workflow reads whichever is present.

Trust policy note: GitHub's OIDC subject includes numeric ids (repo:owner@id/name@id:ref:refs/heads/main). The deploy role trusts the pattern repo:jon659*/security-rag*:ref:refs/heads/main. To reapply it by hand: aws iam update-assume-role-policy --role-name security-rag-deploy --policy-document file://infra/deploy-trust.json --profile <name>

ECR note: Lambda must be allowed to pull the image. setup.sh applies infra/ecr-policy.json to the repository; by hand: aws ecr set-repository-policy --repository-name security-rag --region us-east-2 --policy-text file://infra/ecr-policy.json --profile <name>
