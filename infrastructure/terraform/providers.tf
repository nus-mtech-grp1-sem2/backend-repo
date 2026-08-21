provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project   = "onestage"
      ManagedBy = "terraform"
      Course    = "swe5001"
    }
  }
}
