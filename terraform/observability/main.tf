
variable "cloudfront_distribution_id" {
  type        = string
  description = "CloudFront distribution ID — used to wire CF/WAF alarms in us-east-1"
}

variable "api_gateway_id" {
  type        = string
  description = "API Gateway ID — used to wire API GW alarms in eu-west-2"
}

variable "alert_email" {
  type        = string
  description = "Email for SNS alarm + budget notifications"
}