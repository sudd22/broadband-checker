variable "origin_verify_secret" {
  type        = string
  sensitive   = true
  description = "Shared secret CloudFront injects as X-Origin-Verify; Lambda validates this"
}

variable "cloudfront_domain" {
  type        = string
  description = "cloudfront domain"
}

variable "alert_email" {
  type        = string
  description = "Email for SNS notification"
}

variable "ofcom_api_key" {
  type        = string
  sensitive   = true
  description = "Ofcom Broadband API Key"
}

output "s3_bucket" {
  value       = aws_s3_bucket.static.bucket
  description = "S3 static site bucket name"
}

output "s3_bucket_regional_domain_name" {
  value       = aws_s3_bucket.static.bucket_regional_domain_name
  description = "S3 regional domain — used as CloudFront S3 origin"
}

output "api_gateway_endpoint" {
  value       = aws_apigatewayv2_api.broadband.api_endpoint
  description = "API Gateway execute-api endpoint — CloudFront API origin"
}

output "api_gateway_id" {
  value       = aws_apigatewayv2_api.broadband.id
  description = "API Gateway ID — used by observability alarms"
}