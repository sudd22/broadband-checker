data "terraform_remote_state" "bootstrap" {
  backend = "s3"

  config = {
    bucket = "bbc-tfstate-prod-774667856934"
    key    = "bootstrap/terraform.tfstate"
    region = "eu-west-2"
  }
}


output "cloudfront_domain" {
  value       = module.edge.cloudfront_distribution_domain
  description = "CloudFront distribution domain"
}


output "custom_domain" {
  value       = var.domain_name
  description = "The custom domain"
}

output "api_endpoint" {
  value       = module.origin.api_gateway_endpoint
  description = "Api Gateway execute-api endpoint (eu-west-2)"
}

output "s3_bucket" {
  value       = module.origin.s3_bucket
  description = "s3 static site bucket name"
}

output "acm_cert_arn" {
  value       = module.edge.acm_cert_arn
  description = "ACM certification ARN"
}

output "route_53_zone_id" {
  value       = module.edge.route53_zone_id
  description = "Route 53 hosted zone ID — user must update GoDaddy nameservers to match"
}

output "route53_name_servers" {
  value       = module.edge.route53_name_servers
  description = "Route 53 NS records"
}

output "cloudfront_distribution_id" {
  value       = module.edge.cloudfront_distribution_id
  description = "CloudFront distribution ID (for CloudWatch metrics + alarms)"
}

output "api_gateway_id" {
  value       = module.origin.api_gateway_id
  description = "API Gateway ID (for CloudWatch metrics + alarms)"
}

output "plan_role_arn" {
  value       = data.terraform_remote_state.bootstrap.outputs.plan_role_arn
  description = "ARN of the OIDC plan role (from bootstrap state)"
}

output "deploy_role_arn" {
  value       = data.terraform_remote_state.bootstrap.outputs.deploy_role_arn
  description = "ARN of the OIDC deploy role (from bootstrap state)"
}