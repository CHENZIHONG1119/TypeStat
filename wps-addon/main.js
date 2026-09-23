// 由 index.html 引入。
// 顺序不能改：config.js 提供 TYPESTAT_CONFIG，reporter.js 依赖它，
// ribbon.js 的 OnAddinLoad 里要调 TypeStatReporter.start()。
document.write("<script language='javascript' src='js/config.js'></script>");
document.write("<script language='javascript' src='js/reporter.js'></script>");
document.write("<script language='javascript' src='js/ribbon.js'></script>");
