-- 新交接消费关系只记录本次真实来源，不猜填历史消费记录。
CREATE UNIQUE INDEX handover_project_identity ON handovers(id,project_id);
CREATE TABLE handover_consumptions (
 handover_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 role_id TEXT NOT NULL,
 old_binding_id TEXT NOT NULL,
 old_binding_epoch INTEGER NOT NULL CHECK(old_binding_epoch>=1),
 new_binding_id TEXT NOT NULL,
 new_binding_epoch INTEGER NOT NULL CHECK(new_binding_epoch=old_binding_epoch+1),
 command_id TEXT NOT NULL,
 consumed_at INTEGER NOT NULL CHECK(consumed_at>=0),
 PRIMARY KEY(handover_id,project_id),
 UNIQUE(new_binding_id,project_id),
 FOREIGN KEY(handover_id,project_id) REFERENCES handovers(id,project_id),
 FOREIGN KEY(role_id,project_id) REFERENCES roles(id,project_id),
 FOREIGN KEY(old_binding_id,project_id,old_binding_epoch) REFERENCES role_bindings(id,project_id,epoch),
 FOREIGN KEY(new_binding_id,project_id,new_binding_epoch) REFERENCES role_bindings(id,project_id,epoch),
 FOREIGN KEY(command_id,project_id) REFERENCES commands(id,project_id)
);
CREATE TRIGGER handover_consumption_source BEFORE INSERT ON handover_consumptions
WHEN NOT EXISTS (
 SELECT 1 FROM handovers h
 JOIN role_bindings old ON old.id=NEW.old_binding_id AND old.project_id=NEW.project_id
 JOIN role_bindings next ON next.id=NEW.new_binding_id AND next.project_id=NEW.project_id
 JOIN sessions old_session ON old_session.id=old.session_id
 JOIN sessions next_session ON next_session.id=next.session_id
 JOIN commands c ON c.id=NEW.command_id AND c.project_id=NEW.project_id
 WHERE h.id=NEW.handover_id AND h.project_id=NEW.project_id AND h.role_id=NEW.role_id
 AND h.state='consumed' AND h.from_binding_epoch=NEW.old_binding_epoch
 AND old.role_id=NEW.role_id AND old.epoch=NEW.old_binding_epoch AND old.ended_at=NEW.consumed_at
 AND next.role_id=NEW.role_id AND next.epoch=NEW.new_binding_epoch AND next.started_at=NEW.consumed_at
 AND next.ended_at IS NULL AND next.session_id<>old.session_id
 AND (old_session.harness_id<>next_session.harness_id OR old_session.host_id<>next_session.host_id
 OR old_session.profile_id<>next_session.profile_id OR old_session.native_conversation_id<>next_session.native_conversation_id)
 AND c.type IN ('role.provision','role.bind') AND c.state IN ('stored','completed')
)
BEGIN SELECT RAISE(ABORT,'HANDOVER_CONSUMPTION_SOURCE_MISMATCH'); END;
CREATE TRIGGER handover_consumption_immutable BEFORE UPDATE ON handover_consumptions
BEGIN SELECT RAISE(ABORT,'HANDOVER_CONSUMPTION_IMMUTABLE'); END;
CREATE TRIGGER handover_consumption_preserved BEFORE DELETE ON handover_consumptions
BEGIN SELECT RAISE(ABORT,'HANDOVER_CONSUMPTION_PRESERVED'); END;
