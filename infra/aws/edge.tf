resource "aws_lb" "main" {
  name               = var.name
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
  idle_timeout       = 60
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/healthz"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 10
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  # Anything that did not come through our CloudFront distribution is refused.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_edge" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_no_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# HTTPS: CloudFront's own certificate on *.cloudfront.net, or your domain's certificate when app_domain is set (domain.tf).
# Nothing is cached. Cookies, headers and query strings go through, so the API behaves as it does locally.
resource "aws_cloudfront_distribution" "edge" {
  enabled         = true
  comment         = var.name
  aliases         = local.custom_domain ? [var.app_domain] : []
  price_class     = "PriceClass_100"
  http_version    = "http2"
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 30
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
    # Which address the request came in on. The API serves only previews to the other one.
    custom_header {
      name  = "X-Sdlc-Surface"
      value = "platform"
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # Managed policies: CachingDisabled, and AllViewerExceptHostHeader.
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_no_host.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  dynamic "viewer_certificate" {
    for_each = local.custom_domain ? [] : [1]
    content { cloudfront_default_certificate = true }
  }
  dynamic "viewer_certificate" {
    for_each = local.custom_domain ? [1] : []
    content {
      acm_certificate_arn      = aws_acm_certificate_validation.site[0].certificate_arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }
}

# A second address, only for previews. Code from a pull request is unreviewed, so it is served from an origin that does
# not share cookies or scripts with the platform. It reaches the same load balancer, and the API serves only previews on it.
resource "aws_cloudfront_distribution" "previews" {
  enabled         = true
  comment         = "${var.name} previews"
  aliases         = local.custom_domain ? [var.preview_domain] : []
  price_class     = "PriceClass_100"
  http_version    = "http2"
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 30
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
    custom_header {
      name  = "X-Sdlc-Surface"
      value = "preview"
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_no_host.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  dynamic "viewer_certificate" {
    for_each = local.custom_domain ? [] : [1]
    content { cloudfront_default_certificate = true }
  }
  dynamic "viewer_certificate" {
    for_each = local.custom_domain ? [1] : []
    content {
      acm_certificate_arn      = aws_acm_certificate_validation.site[0].certificate_arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }
}
