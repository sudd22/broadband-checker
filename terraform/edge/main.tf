provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project    = "broadband-checker"
      ManagedBy  = "terraform"
      Repository = "sudd22/broadband-checker"
    }
  }
}


variable "origin_verify_secret" {
  type        = string
  sensitive   = true
  description = "Shared secret CloudFront injects as X-Origin-Verify header on API origin requests"
}

variable "domain_name" {
  type        = string
  description = "Custom domain — ACM cert subject + Route 53 zone + CloudFront alias"
}

variable "s3_bucket_regional_domain_name" {
  type        = string
  description = "S3 regional domain — used as the CloudFront S3 origin"
}

variable "api_gateway_endpoint" {
  type        = string
  description = "API Gateway execute-api endpoint — used as the CloudFront API origin"
}

# ── Outputs (read by root outputs.tf and observability module) ─────────────
output "cloudfront_distribution_domain" {
  value       = aws_cloudfront_distribution.cdn.domain_name
  description = "CloudFront distribution domain"
}

output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.cdn.id
  description = "CloudFront distribution ID — used by observability alarms"
}

output "acm_cert_arn" {
  value       = aws_acm_certificate.cert.arn
  description = "ACM certificate ARN (us-east-1)"
}

output "route53_zone_id" {
  value       = data.aws_route53_zone.main.zone_id
  description = "Route 53 hosted zone ID for the custom domain"
}

output "route53_name_servers" {
  value       = data.aws_route53_zone.main.name_servers
  description = "Route 53 NS records for the domain provider"
}