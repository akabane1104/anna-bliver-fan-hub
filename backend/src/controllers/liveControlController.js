const {
  aliasSchema,
  assignRequestSchema,
  createSessionSchema,
  fulfillmentSchema,
  historyQuerySchema,
  manualRequestSchema,
  matchRequestSchema,
  etaPauseSchema,
  positiveIdParamSchema,
  publicIdParamSchema,
  reorderSchema,
  requestTransitionSchema,
  sessionTransitionSchema,
  songPolicySchema,
  songRequestSettingsSchema,
  undoSchema,
  targetQuerySchema
} = require('../schemas/songRequestSchemas');
const { liveEventAdminQuerySchema } = require('../schemas/liveAdminSchemas');
const {
  liveHomeActivitySchema,
  liveHomeAdvanceSchema,
  liveHomeOverrideSchema,
  songRequestOpenSchema
} = require('../schemas/liveHomeSchemas');
const { defaultLiveAdminService } = require('../services/liveAdminService');
const { defaultLiveHomeService } = require('../services/liveHomeService');
const { createLiveSessionService } = require('../services/liveSessionService');
const {
  defaultSongRequestService
} = require('../services/songRequestService');
const {
  parseOrThrow,
  sendSongRequestError
} = require('./songRequestController');
const {
  defaultObsOverlayRealtime
} = require('../services/obsOverlayRealtime');

const defaultLiveSessionService = createLiveSessionService();

function requestId(req) {
  return parseOrThrow(publicIdParamSchema, req.params, 'invalid_request_id').publicId;
}

function createLiveControlController({
  sessionService = defaultLiveSessionService,
  requestService = defaultSongRequestService,
  liveAdminService = defaultLiveAdminService,
  liveHomeService = defaultLiveHomeService,
  realtime = defaultObsOverlayRealtime
} = {}) {
  const notify = (reason) => realtime.publish(reason);

  const transitionSession = (toStatus) => async (req, res) => {
    try {
      const publicId = requestId(req);
      const input = parseOrThrow(sessionTransitionSchema, req.body);
      const session = await sessionService.transition(
        publicId,
        toStatus,
        input.expected_version
      );
      notify('live_session_changed');
      return res.json({
        status: 'accepted',
        session
      });
    } catch (error) {
      return sendSongRequestError(res, error);
    }
  };

  const transitionRequest = (toStatus) => async (req, res) => {
    try {
      const publicId = requestId(req);
      const input = parseOrThrow(requestTransitionSchema, req.body);
      const request = await requestService.transitionRequest(
        publicId,
        toStatus,
        input,
        req.userId
      );
      notify('song_request_changed');
      return res.json({
        status: 'accepted',
        request: await requestService.getRequest(request.public_id)
      });
    } catch (error) {
      return sendSongRequestError(res, error);
    }
  };

  return {
    async liveHome(req, res) {
      try {
        return res.json(await liveHomeService.getAdminHome());
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async setLiveHomeOverride(req, res) {
      try {
        const input = parseOrThrow(liveHomeOverrideSchema, req.body);
        return res.json(await liveHomeService.setOverride(input, req.userId));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async setSongRequestsOpen(req, res) {
      try {
        const input = parseOrThrow(songRequestOpenSchema, req.body);
        const result = await liveHomeService.setSongRequestsOpen(input.open, req.userId);
        notify('song_request_settings_changed');
        return res.json(result);
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async setLiveHomeActivity(req, res) {
      try {
        const input = parseOrThrow(liveHomeActivitySchema, req.body);
        const result = await liveHomeService.setActivity(input, req.userId);
        notify('activity_changed');
        return res.json(result);
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async advanceCurrent(req, res) {
      try {
        const input = parseOrThrow(liveHomeAdvanceSchema, req.body);
        const result = await requestService.advanceCurrent(
          requestId(req),
          input,
          req.userId
        );
        notify('song_request_advanced');
        return res.json({
          status: 'accepted',
          previous: await requestService.getRequest(result.previous.public_id),
          current: result.current
            ? await requestService.getRequest(result.current.public_id)
            : null
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async liveStatus(req, res) {
      try {
        return res.json(await liveAdminService.getStatus());
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async liveEvents(req, res) {
      try {
        const validation = liveEventAdminQuerySchema.safeParse(req.query);
        if (!validation.success) {
          const error = new Error('查询条件校验失败');
          error.status = 400;
          error.code = 'invalid_live_event_query';
          throw error;
        }
        return res.json(await liveAdminService.listEvents(validation.data));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async createSession(req, res) {
      try {
        const input = parseOrThrow(createSessionSchema, req.body);
        const session = await sessionService.createDraft(input, req.userId);
        notify('live_session_changed');
        return res.status(201).json({
          status: 'accepted',
          session
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    openSession: transitionSession('open'),
    pauseSession: transitionSession('paused'),
    resumeSession: transitionSession('open'),
    closeSession: transitionSession('closed'),

    async currentSession(req, res) {
      try {
        const target = parseOrThrow(targetQuerySchema, req.query, 'invalid_target');
        return res.json({
          session: await sessionService.getCurrent(target.site_id, target.room_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async activeSessions(req, res) {
      try {
        return res.json({ sessions: await sessionService.listActive() });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async recoverableSessions(req, res) {
      try {
        return res.json({ sessions: await sessionService.listRecoverable() });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async sessionRequests(req, res) {
      try {
        return res.json(await requestService.getSessionRequests(requestId(req)));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async observedRequests(req, res) {
      try {
        const target = parseOrThrow(targetQuerySchema, req.query, 'invalid_target');
        return res.json({
          requests: await requestService.getObserved(target.site_id, target.room_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async history(req, res) {
      try {
        const input = parseOrThrow(historyQuerySchema, req.query, 'invalid_history_query');
        return res.json(await requestService.getHistory(input));
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async createManualRequest(req, res) {
      try {
        const input = parseOrThrow(manualRequestSchema, req.body);
        const request = await requestService.createManualRequest(input, req.userId);
        notify('song_request_created');
        return res.status(201).json({
          status: 'accepted',
          request: await requestService.getRequest(request.public_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async getSongRequestSettings(req, res) {
      try {
        return res.json({ settings: await requestService.getPolicySettings() });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async updateSongRequestSettings(req, res) {
      try {
        const input = parseOrThrow(songRequestSettingsSchema, req.body);
        return res.json({
          status: 'accepted',
          settings: await requestService.updatePolicySettings(input, req.userId)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async setEtaPaused(req, res) {
      try {
        const input = parseOrThrow(etaPauseSchema, req.body);
        const settings = await requestService.setEtaPaused(
          input.paused,
          input.expected_revision,
          req.userId
        );
        notify('song_request_settings_changed');
        return res.json({
          status: 'accepted',
          settings
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async undoLastSongRequestAction(req, res) {
      try {
        const input = parseOrThrow(undoSchema, req.body);
        const result = await requestService.undoLatest(
          input.expected_revision,
          req.userId
        );
        notify('song_request_changed');
        return res.json(result);
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async getSongPolicy(req, res) {
      try {
        const songId = parseOrThrow(
          positiveIdParamSchema,
          req.params,
          'invalid_song_id'
        ).id;
        return res.json({ policy: await requestService.getSongPolicy(songId) });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async setSongPolicy(req, res) {
      try {
        const songId = parseOrThrow(
          positiveIdParamSchema,
          req.params,
          'invalid_song_id'
        ).id;
        const input = parseOrThrow(songPolicySchema, req.body);
        return res.json({
          status: 'accepted',
          policy: await requestService.setSongPolicy(songId, input, req.userId)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async assignRequest(req, res) {
      try {
        const input = parseOrThrow(assignRequestSchema, req.body);
        const request = await requestService.assignToSession(requestId(req), input, req.userId);
        notify('song_request_changed');
        return res.json({
          status: 'accepted',
          request: await requestService.getRequest(request.public_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async matchRequest(req, res) {
      try {
        const input = parseOrThrow(matchRequestSchema, req.body);
        const request = await requestService.setManualMatch(requestId(req), input, req.userId);
        notify('song_request_changed');
        return res.json({
          status: 'accepted',
          request: await requestService.getRequest(request.public_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async acceptUnmatched(req, res) {
      try {
        const input = parseOrThrow(requestTransitionSchema, req.body);
        const request = await requestService.acceptUnmatched(requestId(req), input, req.userId);
        notify('song_request_changed');
        return res.json({
          status: 'accepted',
          request: await requestService.getRequest(request.public_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    rejectRequest: transitionRequest('rejected'),
    cancelRequest: transitionRequest('cancelled'),
    activateRequest: transitionRequest('active'),
    completeRequest: transitionRequest('completed'),
    skipRequest: transitionRequest('skipped'),
    failRequest: transitionRequest('failed'),
    requeueRequest: transitionRequest('queued'),
    restoreSkippedRequest: transitionRequest('queued'),

    async setFulfillment(req, res) {
      try {
        const input = parseOrThrow(fulfillmentSchema, req.body);
        const request = await requestService.setFulfillmentType(
          requestId(req),
          input,
          req.userId
        );
        notify('song_request_changed');
        return res.json({
          status: 'accepted',
          request: await requestService.getRequest(request.public_id)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async reorder(req, res) {
      try {
        const input = parseOrThrow(reorderSchema, req.body);
        const result = await requestService.reorder(requestId(req), input, req.userId);
        notify('song_request_changed');
        return res.json({
          status: 'accepted',
          ...result
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async listAliases(req, res) {
      try {
        const songId = parseOrThrow(positiveIdParamSchema, req.params, 'invalid_song_id').id;
        return res.json({ aliases: await requestService.listAliases(songId) });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async addAlias(req, res) {
      try {
        const songId = parseOrThrow(positiveIdParamSchema, req.params, 'invalid_song_id').id;
        const input = parseOrThrow(aliasSchema, req.body);
        return res.status(201).json({
          status: 'accepted',
          alias: await requestService.addAlias(songId, input.alias, req.userId)
        });
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    },

    async deleteAlias(req, res) {
      try {
        const aliasId = parseOrThrow(positiveIdParamSchema, req.params, 'invalid_alias_id').id;
        await requestService.deleteAlias(aliasId);
        return res.status(204).end();
      } catch (error) {
        return sendSongRequestError(res, error);
      }
    }
  };
}

module.exports = { createLiveControlController };
