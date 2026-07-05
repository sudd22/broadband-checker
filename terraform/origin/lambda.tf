data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.root}/../lambda/src"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/broadband-checker"
  retention_in_days = 14
}

resource "aws_lambda_function" "broadband_checker" {
  function_name    = "broadband-checker"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10


  # -1 = "no reserved limit, use account default" (your account has a low
  # total Lambda concurrency, so any positive value would violate the
  # account's minimum-unreserved floor of 10. WAF rate limit still caps abuse.)
  reserved_concurrent_executions = -1

  environment {
    variables = {
      DYNAMODB_TABLE       = aws_dynamodb_table.cache.name
      SSM_PARAM_PATH       = aws_ssm_parameter.ofcom_key.name
      ORIGIN_VERIFY_SECRET = var.origin_verify_secret
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}


resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.broadband_checker.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.broadband.execution_arn}/*/*"
}
