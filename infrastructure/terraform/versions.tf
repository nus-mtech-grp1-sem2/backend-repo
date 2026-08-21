terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    # bucket/key/region/use_lockfile supplied via -backend-config=backend.hcl
    # (see scripts/bootstrap-backend.sh, which creates the bucket before this
    # backend block can be initialized against it).
  }
}
