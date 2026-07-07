



resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["1b511abead59c6ce207077c0ba2c1c5d7af10a3b"]
}

data "aws_caller_identity" "current" {}




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


output "plan_role_arn" { value = aws_iam_role.github_plan.arn }
output "deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "state_bucket" { value = aws_s3_bucket.tfstate.bucket }
output "lock_table" { value = aws_dynamodb_table.tflock.name }