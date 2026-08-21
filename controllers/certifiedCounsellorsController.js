const mongoose = require('mongoose');
const Counsellor = require('../models/Counsellor');

function getActivationLookupFrom(collection, as) {
  return {
    $lookup: {
      from: collection,
      let: { phone: '$phone' },
      pipeline: [
        {
          $match: {
            $expr: {
              $or: [
                { $eq: ['$mobileNumber', '$$phone'] },
                { $eq: ['$whatsappNumber', '$$phone'] },
              ],
            },
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
        {
          $project: {
            _id: 1,
            name: 1,
            email: 1,
            anythingToConvey: 1,
            createdAt: 1,
          },
        },
      ],
      as,
    },
  };
}

function getActivationLookupStages() {
  return [
    getActivationLookupFrom('trainingfeedbacks', 'activationLegacy'),
    getActivationLookupFrom('certified_counsellors_26_27', 'activation2627'),
    {
      $addFields: {
        activationProfile: {
          $let: {
            vars: {
              legacy: { $arrayElemAt: ['$activationLegacy', 0] },
              current: { $arrayElemAt: ['$activation2627', 0] },
            },
            in: {
              $cond: [
                {
                  $gte: [
                    { $ifNull: ['$$current.createdAt', new Date(0)] },
                    { $ifNull: ['$$legacy.createdAt', new Date(0)] },
                  ],
                },
                { $ifNull: ['$$current', '$$legacy'] },
                { $ifNull: ['$$legacy', '$$current'] },
              ],
            },
          },
        },
      },
    },
    {
      $addFields: {
        displayName: {
          $ifNull: ['$activationProfile.name', '$name'],
        },
        displayEmail: {
          $ifNull: ['$activationProfile.email', '$email'],
        },
      },
    },
  ];
}

exports.getCertifiedCounsellors = async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const escaped = q ? q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const re = escaped ? new RegExp(escaped, 'i') : null;

    const rows = await Counsellor.aggregate([
      ...getActivationLookupStages(),
      {
        $lookup: {
          from: 'students',
          let: { counsellorId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$counsellorId', '$$counsellorId'] },
                    { $eq: ['$createdBy', '$$counsellorId'] },
                    { $eq: ['$deletedAt', null] },
                  ],
                },
              },
            },
            { $count: 'total' },
          ],
          as: 'studentStats',
        },
      },
      ...(re
        ? [
            {
              $match: {
                $or: [{ displayName: re }, { displayEmail: re }, { phone: re }],
              },
            },
          ]
        : []),
      {
        $project: {
          _id: 1,
          id: { $toString: '$_id' },
          name: '$displayName',
          email: '$displayEmail',
          phone: 1,
          createdAt: 1,
          studentCount: { $ifNull: [{ $arrayElemAt: ['$studentStats.total', 0] }, 0] },
        },
      },
      { $sort: { studentCount: -1, name: 1 } },
    ]);

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[getCertifiedCounsellors] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.getCertifiedCounsellorDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid counsellor id.' });
    }

    const [counsellor] = await Counsellor.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(id) } },
      ...getActivationLookupStages(),
      {
        $lookup: {
          from: 'students',
          let: { counsellorId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$counsellorId', '$$counsellorId'] },
                    { $eq: ['$createdBy', '$$counsellorId'] },
                    { $eq: ['$deletedAt', null] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 1,
                fullName: 1,
                phone: 1,
                email: 1,
                course: 1,
                status: 1,
                notes: 1,
                createdAt: 1,
              },
            },
            { $sort: { createdAt: -1, fullName: 1 } },
          ],
          as: 'students',
        },
      },
      {
        $project: {
          _id: 1,
          name: '$displayName',
          email: '$displayEmail',
          phone: 1,
          joinedAt: '$createdAt',
          notes: {
            $ifNull: ['$activationProfile.anythingToConvey', ''],
          },
          studentCount: { $size: '$students' },
          students: 1,
        },
      },
    ]);

    if (!counsellor) {
      return res.status(404).json({ success: false, message: 'Counsellor not found.' });
    }

    return res.json({ success: true, data: counsellor });
  } catch (error) {
    console.error('[getCertifiedCounsellorDetail] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
