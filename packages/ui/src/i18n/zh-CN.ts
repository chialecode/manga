export const zhCN = { 'system.cancelled': '操作已取消', 'system.failed': '操作失败' } as const
export type Messages = { readonly [K in keyof typeof zhCN]: string }
