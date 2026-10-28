-- 内核单实例锁：同一存储文件同时至多一个活跃内核。holder为空表示无持有者；
-- heartbeat为最后心跳时刻，超过租约视为持有进程已死亡，允许恢复性接管。
CREATE TABLE IF NOT EXISTS kernel_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  holder TEXT NOT NULL,
  heartbeat INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO kernel_lock(id,holder,heartbeat) VALUES(1,'',0);
