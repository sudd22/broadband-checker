terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }

  backend "s3" {
    bucket         = "bbc-tfstate-prod-774667856934"
    key            = "bootstrap/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "bbc-tf-lock"
    encrypt        = true

  }

}