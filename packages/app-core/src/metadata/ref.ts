import {
  BANGUMI_PAGE_HOSTS,
  classifySearchInput,
  parseBangumiRef,
  type RefFailure,
} from "@manga/contracts/bangumi-ref";

export {
  BANGUMI_PAGE_HOSTS,
  classifySearchInput,
  parseBangumiRef,
  type RefFailure,
};

/** One short sentence for each way a reference can be wrong, in the interface's language. */
export const REF_FAILURE_MESSAGES: Record<RefFailure, string> = {
  empty: "请输入条目编号或条目页面的链接",
  "bad-id": "条目编号应是数字",
  "not-a-subject": "无法识别：请输入条目编号、subject/编号，或 bgm.tv、bangumi.tv、chii.in 的条目页面链接",
  "foreign-host": "只接受 bgm.tv、bangumi.tv、chii.in 的链接",
  "character-page": "这是角色页面；请使用作品条目页面的链接",
  "person-page": "这是人物页面；请使用作品条目页面的链接",
  "other-page": "这不是条目页面；条目页面的地址形如 /subject/编号",
  "extra-path": "请使用条目首页的链接（/subject/编号），不要带子页面路径",
};
