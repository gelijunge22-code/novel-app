-- 收回 0011 里那个 chapter_meta.summary：**一章一句话本来就该只用一份**。
-- 老早就有 `chapter.summary`（剧情面板 / 批量"写摘要"都在用它），
-- 我 0011 又给侧表加了一列，等于同一件事两套实现 —— 那正是""里禁止的东西。
-- 这里直接删掉新加的那一列，统一用 chapter.summary。
-- （SQLite 3.35+ 支持 DROP COLUMN；本机 3.53.1。）
ALTER TABLE chapter_meta DROP COLUMN summary;
