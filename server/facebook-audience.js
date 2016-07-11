import Promise from "bluebird";
import _ from "lodash";
import URI from "urijs";
import crypto from "crypto";
import fbgraph from "fbgraph";
import CAPABILITIES from "./capabilities";

const ACCOUNT_FIELDS = [
  "id",
  "account_id",
  "name",
  "account_status",
  "owner",
  "owner_business",
  "capabilities",
  "business",
  "user_role"
];

const AUDIENCE_FIELDS = [
  "account_id",
  "approximate_count",
  "data_source",
  "delivery_status",
  "description",
  "excluded_custom_audiences",
  "external_event_source",
  "included_custom_audiences",
  "lookalike_spec",
  "name",
  "operation_status",
  "opt_out_link",
  "permission_for_actions",
  "pixel_id",
  "retention_days",
  "rule",
  "subtype",
  "time_content_updated",
  "time_created",
  "time_updated"
];

export default class FacebookAudience {

  static handle(method) {
    return ({ message }, { hull, ship, req }) => {
      const handler = new FacebookAudience(ship, hull, req);
      if (!handler.isConfigured()) {
        const error = new Error("Missing credentials");
        error.status = 403;
        return Promise.reject(error);
      }
      return handler[method](message);
    };
  }

  static sync(ship, hull, req) {
    return new FacebookAudience(ship, hull, req).sync();
  }

  sync() {
    return Promise.all([
      this.fetchAudiences(),
      this.hull.get("segments", { limit: 500 })
    ]).then(([audiences, segments]) => {
      return Promise.all(segments.map(segment => {
        return audiences[segment.id] || this.createAudience(segment);
      }));
    });
  }

  constructor(ship, hull, req) {
    this.ship = ship;
    this.hull = hull;
    this.req = req;
  }

  metric(metric, value = 1) {
    this.hull.utils.metric(metric, value);
  }

  getAccessToken() {
    return _.get(this.ship, "private_settings.facebook_access_token");
  }

  getAccountId() {
    return _.get(this.ship, "private_settings.facebook_ad_account_id");
  }

  getManagerUrl(audience) {
    return `https://www.facebook.com/ads/manager/audiences/detail/?act=${this.getAccountId()}&pid=p3&ids=${audience.id}`;
  }

  getCredentials() {
    return {
      accessToken: this.getAccessToken(),
      accountId: this.getAccountId()
    };
  }

  isConfigured() {
    const { accessToken, accountId } = this.getCredentials();
    return !!(accessToken && accountId);
  }

  createAudience(segment, extract = true) {
    this.metric("audience.create");
    return this.fb("customaudiences", {
      subtype: "CUSTOM",
      retention_days: 180,
      description: segment.id,
      name: `[Hull] ${segment.name}`
    }, "post").then(audience => {
      if (extract) this.requestExtract({ segment, audience });
      return Object.assign({ isNew: true }, audience);
    });
  }

  getOrCreateAudienceForSegment(segment) {
    return this.fetchAudiences().then(audiences => {
      return audiences[segment.id] || this.createAudience(segment);
    });
  }

  handleUserUpdate({ user, changes }) {
    if (changes && changes.segments) {
      const { entered, left } = changes.segments;
      (entered || []).map(this.handleUserEnteredSegment.bind(this, user));
      (left || []).map(this.handleUserLeftSegment.bind(this, user));
    }
  }

  handleUserEnteredSegment(user, segment) {
    return this.getOrCreateAudienceForSegment(segment).then(audience => {
      return this.addUsersToAudience(audience.id, [user]);
    });
  }

  handleUserLeftSegment(user, segment) {
    return this.getOrCreateAudienceForSegment(segment).then(audience => {
      return this.removeUsersFromAudience(audience.id, [user]);
    });
  }

  handleSegmentUpdate(segment) {
    return this.getOrCreateAudienceForSegment(segment);
  }

  handleSegmentDelete(segment) {
    return this.fetchAudiences().then(audiences => {
      const audience = audiences[segment.id];
      return audience && this.fb(audience.id, {}, "del");
    });
  }

  requestExtract({ segment, audience, format = "csv" }) {
    const search = Object.assign({}, this.req.query, {
      segment: segment.id,
      audience: audience && audience.id
    });

    const url = URI(`https://${this.req.hostname}`)
      .path("batch")
      .search(search)
      .toString();

    return this.hull.get(segment.id).then(({ query }) => {
      return this.hull.post("extract/user_reports", {
        format, query, url,
        fields: ["id", "email", "name"]
      });
    });
  }

  removeUsersFromAudience(audienceId, users) {
    return this.updateAudienceUsers(audienceId, users, "del");
  }

  addUsersToAudience(audienceId, users) {
    return this.updateAudienceUsers(audienceId, users, "post");
  }

  updateAudienceUsers(audienceId, users, method) {
    const data = _.compact((users || []).map(({ email }) => {
      return email && crypto.createHash("sha256")
                    .update(email)
                    .digest("hex");
    }));
    if (_.isEmpty(data)) {
      return Promise.resolve({ data: [] });
    }
    const schema = "EMAIL_SHA256";
    const params = { payload: { schema, data } };
    const action = method === "del" ? "remove" : "add";
    this.metric(`audience.users.${action}`, data.length);
    return this.fb(`${audienceId}/users`, params, method);
  }

  fb(path, params = {}, method = "get") {
    fbgraph.setVersion("2.6");
    const { accessToken, accountId } = this.getCredentials();
    if (!accessToken) {
      throw new Error("MissingCredentials");
    }
    return new Promise((resolve, reject) => {
      let fullpath = path;

      if (path.match(/^customaudiences/)) {
        if (!accountId) {
          throw new Error("MissingAccountId");
        }
        fullpath = `act_${accountId}/${path}`;
      }

      const fullparams = Object.assign({}, params, { access_token: accessToken });
      fbgraph[method](fullpath, fullparams, (err, result) => {
        let error;
        if (err) {
          this.metric("errors");
          console.warn("Unauthorized ", JSON.stringify({ fullpath, fullparams }));
          error = {
            ...err,
            fullpath, fullparams, accountId
          };
        }
        return err ? reject(error) : resolve(result);
      });
    });
  }

  fetchPixels(accountId) {
    return this.fb(`act_${accountId}/adspixels`, { fields: "name" });
  }

  fetchImages(accountId) {
    return this.fb(`act_${accountId}/adimages`, { fields: "url_128" });
  }

  fetchAvailableAccounts(params = {}) {
    const fields = ACCOUNT_FIELDS.join(",");
    return this.fb("me/adaccounts", { ...params, fields })
    .then((({ data }) => {
      const promises = [];
      data.map((account) => {
        account.capabilities = _.compact((account.capabilities || []).map(
          cap => (CAPABILITIES[cap] || false)
        )).join(", ");

        const pix = this.fetchPixels(account.account_id).then((pixels) => {
          account.pixels = _.compact((pixels.data || []).map(px => px.name)).join(", ");
          return account;
        });
        promises.push(pix);

        const img = this.fetchImages(account.account_id).then(images => {
          account.images = _.slice((images.data || []).map(i => i.url_128), 0, 4);
          return account;
        });
        promises.push(img);

        return account;
      });

      return Promise.all(promises).then(() => data);
    }));
  }

  fetchAudiences() {
    // TODO Add support for paging
    return this.fb("customaudiences", {
      fields: AUDIENCE_FIELDS.join(","),
      limit: 100
    }).then(({ data }) => {
      return data.reduce((audiences, a) => {
        const match = a.description && a.description.match(/[a-z0-9]{24}/i);
        const segmentId = match && match[0];
        if (segmentId) {
          audiences[segmentId] = a;
        }
        return audiences;
      }, {});
    });
  }

}
