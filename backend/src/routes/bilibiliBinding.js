const router = require('express').Router();
const controller = require('../controllers/bilibiliBindingController');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

router.use(auth);
router.post('/qr', asyncHandler(controller.createQr));
router.get('/qr/:key', asyncHandler(controller.pollQr));
router.get('/status', asyncHandler(controller.getBindingStatus));
router.post('/:bilibiliUid/primary', asyncHandler(controller.setPrimary));
router.post('/:bilibiliUid/sync', asyncHandler(controller.resync));
router.delete('/:bilibiliUid', asyncHandler(controller.unbind));

module.exports = router;
