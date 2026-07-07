variable "domain_name" {
  type        = string
  description = "Custom domain (e.g. seudd.online) — must be registered and delegated to Route 53"
}

variable "alert_email" {
  type        = string
  description = "Email address for SNS alarm + budget notifications"
}

variable "github_org" {
  type    = string
  default = "sudd22"
}

variable "github_repo" {
  type    = string
  default = "broadband-checker"
}


variable "ofcom_api_key" {
  type        = string
  sensitive   = true
  description = "Ofcom Broadband API Key"
  default     = "placeholder"
}
