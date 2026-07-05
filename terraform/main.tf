terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket         = "bbc-tfstate-prod-774667856934"
    key            = "broadband-checker/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "bbc-tf-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = "eu-west-2"
  default_tags {
    tags = {
      Project    = "broadband-checker"
      ManagedBy  = "terraform"
      Repository = "sudd22/broadband-checker"
    }
  }
}


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


resource "random_password" "origin_verify" {
  length  = 32
  special = false
}


module "origin" {
  source = "./origin"

  providers = {
    aws = aws
  }

  origin_verify_secret = random_password.origin_verify.result
  cloudfront_domain    = var.domain_name
  alert_email          = var.alert_email
  ofcom_api_key        = var.ofcom_api_key
}


module "edge" {
  source = "./edge"

  providers = {
    aws = aws.us_east_1
  }

  origin_verify_secret           = random_password.origin_verify.result
  domain_name                    = var.domain_name
  s3_bucket_regional_domain_name = module.origin.s3_bucket_regional_domain_name
  api_gateway_endpoint           = module.origin.api_gateway_endpoint
}


module "observability" {
  source = "./observability"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  cloudfront_distribution_id = module.edge.cloudfront_distribution_id
  api_gateway_id             = module.origin.api_gateway_id
  alert_email                = var.alert_email
}