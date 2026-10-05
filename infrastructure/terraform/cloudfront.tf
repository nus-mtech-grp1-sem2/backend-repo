# Dual-origin design: default behavior serves the SPA from S3, /api/*
# forwards to the backend ALB. Every browser request is same-origin from
# CloudFront's perspective, so core-frontend's API_BASE_URL (default "/api")
# needs no build-time override, and Kong's cors plugin is unnecessary
# (removed from kong.yml) — there's no cross-origin call to allow.

# Angular client-side routing for the S3 behavior only; see the function file.
resource "aws_cloudfront_function" "spa_routing" {
  name    = "${local.name_prefix}-spa-routing"
  runtime = "cloudfront-js-2.0"
  comment = "Serve index.html for Angular routes (paths without a file extension)"
  publish = true
  code    = file("${path.module}/functions/spa-routing.js")
}

# No WAF: ~US$6+/month for a course demo; Kong rate-limits the API instead.
# Minimum TLS version cannot be raised while using the default *.cloudfront.net
# certificate (it needs a custom domain and ACM certificate); viewers are still
# redirected to HTTPS on every behavior.
#tfsec:ignore:aws-cloudfront-enable-waf
#tfsec:ignore:aws-cloudfront-use-secure-tls-policy
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_200" # includes SEA edge locations; traffic is inside the free tier either way

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = "alb-backend"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # ALB listener is HTTP only; TLS terminates at CloudFront
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # AWS managed: CachingOptimized

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_routing.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "alb-backend"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # AWS managed: CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AWS managed: AllViewerExceptHostHeader
  }

  # No custom_error_response: those apply to every behavior, so they turned
  # the API's 403/404 JSON errors into 200 + index.html. Deep links are
  # served by the spa_routing function on the S3 behavior instead.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Bucket ACL/ownership prerequisites for CloudFront's log delivery live in
  # logging.tf, next to the bucket itself.
  logging_config {
    bucket          = aws_s3_bucket.access_logs.bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
