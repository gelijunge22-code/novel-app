-- ⑨ 对端同步：每个文件「上次同步时服务器那版是什么 mtime」。
-- 为什么单独一个迁移：0008 已经跑过了，**跑过的迁移不许再改**（改了不会重跑，
-- 本地就会缺表 —— 正是这么踩的：no such table: peer_file）。

--    为什么必须有这张表：冲突判断的基准是**文件的 mtime**，不是服务器时钟。
--    踩过：一开始拿 `last_time`（服务器时钟）当 push 的 baseMtimeMs，
--    服务器一比对就判"你改的时候我这版也变了"，于是**每推必冲突** ——
--    用户挑完合并稿也推不上去，成了死循环。
CREATE TABLE IF NOT EXISTS peer_file (
  slug         TEXT NOT NULL,
  path         TEXT NOT NULL,
  server_mtime INTEGER NOT NULL DEFAULT 0,
  at           INTEGER NOT NULL,
  PRIMARY KEY(slug, path)
);
