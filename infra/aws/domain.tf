# Your own domain (optional). With app_domain, preview_domain and hosted_zone_id set, the platform and its previews are
# served on those names over HTTPS. The records and the certificate's validation records go into the hosted zone you name,
# and destroy removes them. Without them, nothing here is created and the CloudFront addresses are used.

resource "aws_acm_certificate" "site" {
  count                     = local.custom_domain ? 1 : 0
  provider                  = aws.us_east_1
  domain_name               = var.app_domain
  subject_alternative_names = [var.preview_domain]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.custom_domain ? {
    for o in aws_acm_certificate.site[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}
  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  count                   = local.custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

locals {
  names = local.custom_domain ? {
    app      = { name = var.app_domain, cf = aws_cloudfront_distribution.edge }
    previews = { name = var.preview_domain, cf = aws_cloudfront_distribution.previews }
  } : {}
}

resource "aws_route53_record" "site_a" {
  for_each = local.names
  zone_id  = var.hosted_zone_id
  name     = each.value.name
  type     = "A"
  alias {
    name                   = each.value.cf.domain_name
    zone_id                = each.value.cf.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  for_each = local.names
  zone_id  = var.hosted_zone_id
  name     = each.value.name
  type     = "AAAA"
  alias {
    name                   = each.value.cf.domain_name
    zone_id                = each.value.cf.hosted_zone_id
    evaluate_target_health = false
  }
}
