import Hull from "hull";
import Server from "./server";
import librato from "librato-node";


Hull.onLog(function onLog(message, data, ctx = {}) {
  console.log(`[ ${ctx.id} ] segment.${message}`, JSON.stringify(data || ""));
});

Hull.onMetric(function onMetric(metric, value, ctx = {}) {
  console.log(`[ ${ctx.id} ] segment.${metric}`, value);
});

if (process.env.LIBRATO_TOKEN && process.env.LIBRATO_USER) {
  librato.configure({
    email: process.env.LIBRATO_USER,
    token: process.env.LIBRATO_TOKEN
  });
  librato.on("error", function onError(err) {
    console.error(err);
  });

  process.once("SIGINT", function onSigint() {
    librato.stop(); // stop optionally takes a callback
  });
  librato.start();

  Hull.onLog(function onLog(message, data = {}, ctx = {}) {
    try {
      const payload = typeof(data) === "object" ? JSON.stringify(data) : data;
      console.log(`[${ctx.id}] ${message}`, payload);
    } catch (err) {
      console.log(err);
    }
  });

  Hull.onMetric(function onMetricProduction(metric = "", value = 1, ctx = {}) {
    try {
      if (librato) {
        librato.measure(`facebook-audiences.${metric}`, value, Object.assign({}, { source: ctx.id }));
      }
    } catch (err) {
      console.warn("error in librato.measure", err);
    }
  });
}


Server({
  Hull,
  facebookAppId: process.env.FACEBOOK_APP_ID,
  facebookAppSecret: process.env.FACEBOOK_APP_SECRET,
  port: process.env.PORT || 8082,
  sentryDSN: process.env.SENTRY_DSN
});
