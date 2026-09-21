-- 参考书架（18.5）：把「值得学的别人的写法」放进来，写的时候能查到、能挑一句带进提示词。
-- 和「素材」（灵感碎片）分开：素材是**要用的料**，参考是**学人家的写法**，混一起两件事都做不好。
CREATE TABLE IF NOT EXISTS reference (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',      -- 出处：书名/网址/自己记的
  kind        TEXT NOT NULL DEFAULT 'excerpt',-- excerpt 摘抄 / note 心得 / doc 整篇
  tags_json   TEXT NOT NULL DEFAULT '[]',
  text        TEXT NOT NULL DEFAULT '',
  words       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reference_slug ON reference(slug, id);
