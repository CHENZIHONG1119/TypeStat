/*
 * 功能区（ribbon）回调。OnAddinLoad 是整个加载项**第一个**被执行的函数。
 *
 * 顺带说明这里为什么要把启动逻辑放在 OnAddinLoad 里：它是加载项拿到
 * window.Application 的最早时机，而下载项要让 TypeStatReporter 尽早挂上
 * ContentChange，晚挂一秒就少统计一秒。
 */

function OnAddinLoad(ribbonUI) {
  // 模板里的通用做法：把 ribbonUI 和枚举挂到 Application 上，
  // 后续按钮状态刷新（InvalidateControl）要用。
  if (typeof window.Application.ribbonUI != "object") {
    window.Application.ribbonUI = ribbonUI;
  }
  if (typeof window.Application.Enum != "object") {
    window.Application.Enum = { msoCTPDockPositionLeft: 0, msoCTPDockPositionRight: 2 };
  }

  // reporter.js 在脚本加载时已经自己 start() 过一次了；这里再调一次是幂等的，
  // 作用是兜住「脚本执行时 Application 还没注入完」那一种情况。
  TypeStatReporter.start();

  return true;
}

function GetUrlPath() {
  var e = decodeURI(document.location.toString());
  if (e.indexOf("/") != -1) e = e.substring(0, e.lastIndexOf("/"));
  return e;
}

function OnAction(control) {
  switch (control.Id) {
    case "btnStatus":
      openStatusDialog();
      break;

    case "btnTest":
      TypeStatReporter.testConnection(function (code, text) {
        if (code === 200) {
          alert(
            "通路正常。\n\n" +
              "接收端 127.0.0.1:" +
              TYPESTAT_CONFIG.port +
              " 在线，令牌有效。\n" +
              "（这条测试上报里字符数是 0，不会污染统计。）"
          );
        } else {
          alert(
            "连接失败：" +
              text +
              "\n\n排查顺序：\n" +
              "1. TypeStat 是不是没在跑？\n" +
              "2. 设置页显示的端口是不是 " +
              TYPESTAT_CONFIG.port +
              "？\n" +
              "3. 设置页的令牌和 js/config.js 里的是否一致？重新生成过就要重跑 install.mjs。"
          );
        }
      });
      break;

    case "btnReconnect":
      // reconnect 内部是先让位再取位：如果还有别的加载项页面在收事件，
      // 直接再挂一次监听会让同一次改动被上报两遍，字数凭空翻倍。
      // 由「统计状态」里的选举机制保证同一时刻只有一个实例在收。
      if (TypeStatReporter.reconnect()) {
        alert("已重新取得监听。\n打开「统计状态」可以看到事件是否在进来。");
      } else {
        alert(
          "没能挂上监听。\n\n" +
            "通常是 window.Application 还没就绪——等几秒再试一次。\n" +
            "如果一直不行，重启 WPS。"
        );
      }
      break;
  }
}

function openStatusDialog() {
  TypeStatReporter.flush(); // 打开对话框前先把攒着的送出去，看到的数字才是最新的
  window.Application.ShowDialog(
    GetUrlPath() + "/ui/status.html",
    "TypeStat 统计状态",
    560 * window.devicePixelRatio,
    480 * window.devicePixelRatio,
    false
  );
}
