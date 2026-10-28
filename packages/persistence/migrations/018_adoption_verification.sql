-- 0018 复核修复：原生会话来源核验。verified_origin=1（受信启动器/工厂创建，既有行默认）；
-- 0=控制主体声明的接纳（adopt）——须经真实原生交互成功（resume 回执匹配）核验后才可 startup_ack→ready。
ALTER TABLE sessions ADD COLUMN verified_origin INTEGER NOT NULL DEFAULT 1;
