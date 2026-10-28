'use strict';

/**
 * 五子棋扩展入口
 *
 * 主服务按 extensions/ 下的扩展清单加载，每个扩展导出 create(context)。
 * context 提供主服务的通用能力（广播、设备查询、请求体解析、JSON 响应、发送者解析），
 * 扩展自身不直接访问主服务的内部状态。
 *
 * 返回实例约定：
 *   {
 *     name,       扩展标识
 *     mount,      URL 挂载前缀（API 与静态资源共用，如 /gomoku）
 *     staticDir,  静态资源目录（/gomoku/* → 此目录）
 *     handle,     API 路由处理函数 handle(req, res, pathname, method) → boolean
 *     game,       对局管理器（供其它扩展或调试读取当前状态）
 *   }
 */

const { createGomokuGame } = require('./server');
const { createGomokuRoutes } = require('./routes');

module.exports = {
  name: 'gomoku',
  mount: '/gomoku',

  create({ broadcast, getDevice, readBody, sendJSON, parseSender }) {
    const game = createGomokuGame({ broadcast, getDevice });

    return {
      name: 'gomoku',
      mount: '/gomoku',
      staticDir: __dirname,
      handle: createGomokuRoutes({ game, readBody, sendJSON, parseSender }),
      game,
    };
  },
};
