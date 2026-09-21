-- ① 参考书架收**文件与图片**（用户原话：把"这个人的具体感觉该怎么写"发一张图进来给 AI 参考）。
--    0007 建表时只考虑了文字摘抄，这里补两列：存在书里哪个文件、什么类型。
--    为什么单独一个迁移：跑过的迁移不许再改（0007 已经跑过），改了不会重跑 → 本地就缺列。
ALTER TABLE reference ADD COLUMN file TEXT NOT NULL DEFAULT '';   -- 相对 <书>/.novel/refs/ 的文件名
ALTER TABLE reference ADD COLUMN mime TEXT NOT NULL DEFAULT '';   -- 服务端给的原样类型（回放时不用猜）
