# ── GitHub OIDC provider ────────────────────────────────────────────────────
# Lets GitHub Actions OIDC tokens be exchanged for AWS STS credentials.
# The thumbprint is GitHub's well-known signing certificate — same for all
# customers, not a secret.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["1b511abead59c6ce207077c0ba2c1c5d7af10a3b"]
}

data "aws_caller_identity" "current" {}

# ── Plan role (read-only, used by ci + terraform-plan on PRs) ───────────────
# StringLike is correct here — the `:*` is a real wildcard matching any
# ref/PR from this repo. Permissions attached in Phase 5 main Terraform.
resource "aws_iam_role" "github_plan" {
  name = "github-actions-plan"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com" }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:sudd22/broadband-checker:*"
        }
      }
    }]
  })
}

# ── Deploy role (mutating, gated by GitHub Environment) ─────────────────────
# StringEquals (NOT StringLike) — these are exact-match environment subjects.
# List semantics: ANY match satisfies the condition, so both `production` and
# `production-destroy` work. Permissions attached in Phase 5 main Terraform.
resource "aws_iam_role" "github_deploy" {
  name = "github-actions-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com" }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [
            "repo:sudd22/broadband-checker:environment:production",
            "repo:sudd22/broadband-checker:environment:production-destroy",
          ]
        }
      }
    }]
  })
}

# Outputs we'll capture in PROJECT_STATE.md for Phase 7 secrets
output "plan_role_arn" { value = aws_iam_role.github_plan.arn }
output "deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "state_bucket" { value = aws_s3_bucket.tfstate.bucket }
output "lock_table" { value = aws_dynamodb_table.tflock.name }