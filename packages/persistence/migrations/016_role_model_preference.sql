-- T115（PR2-W2）：角色模型偏好三态存储。
-- requested：用户原始意图原文（如"6.1sol 极高"）+时间——不猜测替换；
-- resolved：按目标版本能力映射后的配置（modelId/参数），映射依据引用；
-- effective/reported 由执行回执记录（attempts/事件），不入本表。
ALTER TABLE roles ADD COLUMN model_requested_json TEXT CHECK(model_requested_json IS NULL OR json_valid(model_requested_json));
ALTER TABLE roles ADD COLUMN model_resolved_json TEXT CHECK(model_resolved_json IS NULL OR json_valid(model_resolved_json));
