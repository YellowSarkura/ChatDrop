'use strict';

/**
 * 技术问答扩展入口
 *
 * 挂载点 /qa 同时用于 API 之外的静态资源：
 *   /qa/client.js、/qa/style.css、/qa/panel.html
 *
 * 数据库文件放在主服务的数据目录：<dataDir>/technicalQA.db。
 * create() 时打开数据库并打印全部问题与回答，便于启动后快速核对数据。
 */

const path = require('path');
const { createStore } = require('./db');
const { createTechnicalQaRoutes } = require('./routes');

module.exports = {
  name: 'technicalQA',
  mount: '/qa',

  create({ dataDir, readBody, sendJSON }) {
    const store = createStore(path.join(dataDir, 'technicalQA.db'));
    store.dumpAll();

    return {
      name: 'technicalQA',
      mount: '/qa',
      staticDir: __dirname,
      handle: createTechnicalQaRoutes({ store, readBody, sendJSON }),
    };
  },
};
