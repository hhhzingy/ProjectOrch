-- 内部候选查询索引。不修改或删除历史事件、命令或候选；支持配置重评估合并与监督读取。
CREATE INDEX outbox_command_state ON outbox(command_id,state);
CREATE INDEX workflow_pending_target ON outbox(
 json_extract(payload_json,'$.projectId'),json_extract(payload_json,'$.taskId'),
 json_extract(payload_json,'$.taskRevision'),json_extract(payload_json,'$.specRevision')
) WHERE state='pending' AND json_extract(payload_json,'$.event')='workflow.evaluate';
