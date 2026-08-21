# Only 2 repos, not 8 — all 7 Node services share one image, selected by the
# SERVICE env var at container start (see infrastructure/Dockerfile).
resource "aws_ecr_repository" "backend" {
  name                 = "${local.name_prefix}-backend"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_repository" "kong" {
  name                 = "${local.name_prefix}-kong"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy     = data.aws_ecr_lifecycle_policy_document.default.json
}

resource "aws_ecr_lifecycle_policy" "kong" {
  repository = aws_ecr_repository.kong.name
  policy     = data.aws_ecr_lifecycle_policy_document.default.json
}

data "aws_ecr_lifecycle_policy_document" "default" {
  rule {
    priority    = 1
    description = "Expire untagged images after 7 days"
    selection {
      tag_status   = "untagged"
      count_type   = "sinceImagePushed"
      count_unit   = "days"
      count_number = 7
    }
  }

  rule {
    priority    = 2
    description = "Keep only the last 10 tagged images"
    selection {
      tag_status       = "tagged"
      tag_pattern_list = ["*"]
      count_type       = "imageCountMoreThan"
      count_number     = 10
    }
  }
}
