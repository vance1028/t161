-- 社区长者助餐运营管理平台 表结构（全程 utf8mb4，确保中文正常）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(64) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'VIEWER',
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 助餐点（社区食堂）
CREATE TABLE IF NOT EXISTS canteens (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code        VARCHAR(32) NOT NULL UNIQUE,
  name        VARCHAR(128) NOT NULL,
  district    VARCHAR(64) NOT NULL,
  address     VARCHAR(255) NOT NULL DEFAULT '',
  capacity    INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 长者档案
CREATE TABLE IF NOT EXISTS elders (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL,
  gender        VARCHAR(8) NOT NULL DEFAULT 'U',
  age           INT NOT NULL DEFAULT 0,
  phone         VARCHAR(32) NOT NULL DEFAULT '',
  subsidy_level VARCHAR(8) NOT NULL DEFAULT 'C',
  identities    VARCHAR(128) NOT NULL DEFAULT '',
  dietary       VARCHAR(255) NOT NULL DEFAULT '',
  canteen_id    INT UNSIGNED NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_elder_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 餐次（某助餐点某日某餐别提供的菜品）
CREATE TABLE IF NOT EXISTS meals (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  canteen_id  INT UNSIGNED NOT NULL,
  serve_date  DATE NOT NULL,
  meal_type   VARCHAR(16) NOT NULL DEFAULT 'LUNCH',
  dish_name   VARCHAR(128) NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_meal_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE CASCADE,
  INDEX idx_meal_date (serve_date),
  INDEX idx_meal_canteen (canteen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 订餐
CREATE TABLE IF NOT EXISTS orders (
  id           INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id     INT UNSIGNED NOT NULL,
  meal_id      INT UNSIGNED NOT NULL,
  dining_type  VARCHAR(16) NOT NULL DEFAULT 'DINE_IN',
  qty          INT NOT NULL DEFAULT 1,
  amount_cents INT NOT NULL DEFAULT 0,
  subsidy_cents INT NOT NULL DEFAULT 0,
  pay_cents    INT NOT NULL DEFAULT 0,
  status       VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_order_elder FOREIGN KEY (elder_id) REFERENCES elders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_meal FOREIGN KEY (meal_id) REFERENCES meals(id) ON DELETE CASCADE,
  INDEX idx_order_status (status),
  INDEX idx_order_elder (elder_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 补贴规则（可配置、按优先级叠加）
CREATE TABLE IF NOT EXISTS subsidy_rules (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code        VARCHAR(32) NOT NULL UNIQUE,
  name        VARCHAR(128) NOT NULL,
  rule_type   VARCHAR(32) NOT NULL,
  priority    INT NOT NULL DEFAULT 0,
  condition_json JSON NULL,
  amount_cents INT NOT NULL DEFAULT 0,
  percent     DECIMAL(5,2) NOT NULL DEFAULT 0,
  meal_types  VARCHAR(64) NOT NULL DEFAULT '',
  is_holiday  TINYINT(1) NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  effective_from DATE NOT NULL,
  effective_to   DATE NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_rule_type (rule_type),
  INDEX idx_effective (effective_from, effective_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 订单补贴明细（每笔订单各项补贴的明细记录）
CREATE TABLE IF NOT EXISTS order_subsidy_details (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id    INT UNSIGNED NOT NULL,
  rule_id     INT UNSIGNED NOT NULL,
  rule_code   VARCHAR(32) NOT NULL,
  rule_name   VARCHAR(128) NOT NULL,
  rule_type   VARCHAR(32) NOT NULL,
  amount_cents INT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_detail_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_detail_rule FOREIGN KEY (rule_id) REFERENCES subsidy_rules(id) ON DELETE RESTRICT,
  INDEX idx_detail_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 月度补贴使用累计（跨餐次累计，用于封顶控制）
CREATE TABLE IF NOT EXISTS monthly_subsidy_usage (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id    INT UNSIGNED NOT NULL,
  month       CHAR(7) NOT NULL,
  used_cents  INT NOT NULL DEFAULT 0,
  cap_cents   INT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_usage_elder FOREIGN KEY (elder_id) REFERENCES elders(id) ON DELETE CASCADE,
  UNIQUE KEY uk_elder_month (elder_id, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 结算单（月末财政补贴结算）
CREATE TABLE IF NOT EXISTS settlement_sheets (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  month       CHAR(7) NOT NULL,
  canteen_id  INT UNSIGNED NULL,
  sheet_type  VARCHAR(32) NOT NULL,
  group_key   VARCHAR(64) NOT NULL,
  group_value VARCHAR(128) NOT NULL,
  order_count INT NOT NULL DEFAULT 0,
  total_amount_cents INT NOT NULL DEFAULT 0,
  total_subsidy_cents INT NOT NULL DEFAULT 0,
  total_pay_cents INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  snapshot_rules JSON NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_settlement_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE SET NULL,
  INDEX idx_settlement_month (month),
  INDEX idx_settlement_type (sheet_type),
  UNIQUE KEY uk_month_type_group (month, sheet_type, group_key, canteen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 结算勾稽差异
CREATE TABLE IF NOT EXISTS settlement_discrepancies (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  settlement_id INT UNSIGNED NOT NULL,
  order_id    INT UNSIGNED NOT NULL,
  issue_type  VARCHAR(32) NOT NULL,
  expected_cents INT NOT NULL DEFAULT 0,
  actual_cents INT NOT NULL DEFAULT 0,
  diff_cents  INT NOT NULL DEFAULT 0,
  description VARCHAR(255) NOT NULL,
  resolved    TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_disc_settlement FOREIGN KEY (settlement_id) REFERENCES settlement_sheets(id) ON DELETE CASCADE,
  CONSTRAINT fk_disc_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_disc_settlement (settlement_id),
  INDEX idx_disc_resolved (resolved)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 月度结算锁定（已确认上报的月份锁定，防止被覆盖）
CREATE TABLE IF NOT EXISTS monthly_settlement_locks (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  month       CHAR(7) NOT NULL UNIQUE,
  locked_by   INT UNSIGNED NOT NULL,
  locked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  remark      VARCHAR(255) NOT NULL DEFAULT '',
  CONSTRAINT fk_lock_user FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 节假日（统一数据来源，补贴结算自动读取）
CREATE TABLE IF NOT EXISTS holidays (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  holiday_date DATE NOT NULL UNIQUE,
  name        VARCHAR(64) NOT NULL DEFAULT '',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
