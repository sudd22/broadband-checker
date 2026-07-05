resource "aws_sns_topic" "alerts" {
  name = "bbc-alerts"

}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email

}

resource "aws_sns_topic" "alerts_use1" {
  name     = "bbc-alerts-use1"
  provider = aws.us_east_1

}

resource "aws_sns_topic_subscription" "email_use1" {
  topic_arn = aws_sns_topic.alerts_use1.arn
  protocol  = "email"
  endpoint  = var.alert_email
  provider  = aws.us_east_1

}

locals {
  cf_dims = { DistributionId = var.cloudfront_distribution_id }
}

resource "aws_cloudwatch_metric_alarm" "cf_4xx" {
  provider            = aws.us_east_1
  alarm_name          = "bbc-cf-xx-rate"
  alarm_description   = "CloudFront 4xx errror rate exceeds 4% - check for bad requests or waf false positives"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts_use1.arn]
  ok_actions          = [aws_sns_topic.alerts_use1.arn]

  metric_query {
    id          = "rate"
    expression  = "m1 / m2 * 100"
    return_data = true
  }

  metric_query {
    id = "m1"
    metric {
      namespace   = "Aws/CloudFront"
      metric_name = "4xxErrorRate"
      period      = 300
      stat        = "Average"
      dimensions  = local.cf_dims
    }

  }

  metric_query {
    id = "m2"
    metric {
      namespace   = "Aws/CloudFront"
      metric_name = "Requests"
      period      = 300
      stat        = "Sum"
      dimensions  = local.cf_dims
    }
  }

}

resource "aws_cloudwatch_metric_alarm" "cf_5xx" {
  provider            = aws.us_east_1
  alarm_name          = "bbc-cf-5xx-rate"
  alarm_description   = "CloudFront 5xx error rate exceeds 1% — origin may be returning errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts_use1.arn]
  ok_actions          = [aws_sns_topic.alerts_use1.arn]
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  period              = 300
  statistic           = "Average"
  dimensions          = local.cf_dims
}

resource "aws_cloudwatch_metric_alarm" "waf_blocked" {
  provider            = aws.us_east_1
  alarm_name          = "bbc-waf-blocked-spikes"
  alarm_description   = "WAF blocked > 100 request in 5 minutes - possible attack"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 100
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts_use1.arn]
  ok_actions          = [aws_sns_topic.alerts_use1.arn]
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  period              = 300
  statistic           = "Sum"
  dimensions = {
    WebACL = "bbc-waf"
    Rule   = "ALL"
    Region = "CloudFront"
  }

}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "bbc-lambda-errors"
  alarm_description   = "Lambda threw an unhandled error — check /aws/lambda/broadband-checker logs"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  period              = 60
  statistic           = "Sum"
  dimensions          = { FunctionName = "broadband-checker" }

}


resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  alarm_name          = "bbc-lambda-duration"
  alarm_description   = "Lambda p95 duration > 3 s — Ofcom API may be slow or cold starts are frequent"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = 3000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  period              = 300
  extended_statistic  = "p95"
  dimensions          = { FunctionName = "broadband-checker" }

}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "bbc-lambda-throttles"
  alarm_description   = "Lambda throttled — concurrency limit may be too low"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  period              = 300
  statistic           = "Sum"
  dimensions          = { FunctionName = "broadband-checker" }

}

resource "aws_cloudwatch_metric_alarm" "dynamodb_read_throttles" {
  alarm_name          = "bbc-dynamodb-read-throttles"
  alarm_description   = "DynamoDB read throttles — on-demand table may need capacity review"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  namespace           = "AWS/DynamoDB"
  metric_name         = "ReadThrottleEvents"
  period              = 300
  statistic           = "Sum"
  dimensions          = { TableName = "broadband-checker" }

}