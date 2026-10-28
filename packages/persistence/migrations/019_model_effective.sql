-- 0019 复核二段接线：执行侧生效模型权威观察（会话锚定模型的实际值——区别于用户requested与映射resolved）。
ALTER TABLE roles ADD COLUMN model_effective_json TEXT;
