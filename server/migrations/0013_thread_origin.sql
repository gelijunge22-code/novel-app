-- 第 32 轮：把「剧情线」的作用改成**大纲**（用户点名）——
-- 它现在要能回答一个问题：**这条大纲是谁定的？** 用户手改过的，AI 不许覆盖。
-- 所以给 thread 加一列 origin（user / ai）。**只加不删**：老数据一律当 user
-- （连"用户自己定的"都算 AI 的，就会让 AI 去改用户的东西 —— 那正是用户点名的破事）。
-- 说明：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，靠迁移表保证只跑一次。
ALTER TABLE thread ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
