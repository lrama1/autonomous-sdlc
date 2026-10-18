resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "session" {
  length  = 48
  special = false
}

resource "random_password" "origin_verify" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier                 = var.name
  engine                     = "postgres"
  engine_version             = "16"
  instance_class             = "db.t4g.micro"
  allocated_storage          = 20
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = "sdlc"
  username                   = "sdlc"
  password                   = random_password.db.result
  db_subnet_group_name       = aws_db_subnet_group.main.name
  vpc_security_group_ids     = [aws_security_group.db.id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = 1
  skip_final_snapshot        = true
  deletion_protection        = false
  auto_minor_version_upgrade = true
  apply_immediately          = true
  lifecycle { ignore_changes = [engine_version] }
}

# ---- secrets that ECS injects. Deleted at once on destroy, because this is a development stack.
locals {
  config_secrets = {
    database_url          = "postgres://sdlc:${random_password.db.result}@${aws_db_instance.main.address}:5432/sdlc"
    session_secret        = random_password.session.result
    oidc_client_secret    = aws_cognito_user_pool_client.web.client_secret
    openrouter_key_agents = var.openrouter_key_agents
  }
}

resource "aws_secretsmanager_secret" "config" {
  for_each                = toset(keys(local.config_secrets))
  name                    = "${var.name}/config/${each.key}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "config" {
  for_each      = aws_secretsmanager_secret.config
  secret_id     = each.value.id
  secret_string = local.config_secrets[each.key]
}
