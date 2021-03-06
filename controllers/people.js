const uuid = require('uuid');
const { validationResult } = require('express-validator');

const Person = require('../models/person');
const User = require('../models/user');
const { checkImageFileExtension } = require('../utils/fs');
const {
  s3DeleteFileSync,
  s3UploadFileSync,
  indexFacesSync,
  deleteFacesFromCollectionSync,
} = require('../utils/aws');

const AWS_PEOPLE_BKTNAME = process.env.AWS_PEOPLE_BKTNAME;

exports.getPeople = async (req, res, next) => {
  const userId = req.userId;
  try {
    const totalPeople = await Person.find({
      userId: userId.toString(),
    }).countDocuments();
    const people = await Person.find({ userId: userId.toString() });
    const resPeople = people.map((p) => {
      return {
        _id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        counter: p.counter,
        doNotify: p.doNotify,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
    res.status(200).json({
      message: 'People retrieved successfully.',
      people: resPeople,
      totalPeople: totalPeople,
    });
  } catch (error) {
    next(error);
  }
};

exports.getPerson = async (req, res, next) => {
  const personId = req.params.personId;
  const userId = req.userId;
  try {
    const person = await Person.findById(personId);
    if (!person) {
      const error = new Error('Could not find person.');
      error.statusCode = 404;
      throw error;
    }
    if (person.userId.toString() !== userId.toString()) {
      const error = new Error('Not authorized. You are not the creator.');
      error.statusCode = 401;
      throw error;
    }
    res.status(200).json({
      message: 'Person retrieved successfully.',
      person: {
        _id: person.id,
        name: person.name,
        description: person.description,
        imageUrl: person.imageUrl,
        counter: person.counter,
        doNotify: person.doNotify,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.createPerson = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new Error('Validation failed.');
    error.statusCode = 422;
    error.errors = errors.array();
    return next(error);
  }
  if (!req.files) {
    const error = new Error('Please insert an image.');
    error.statusCode = 422;
    return next(error);
  }
  const image = req.files.image;
  if (!image) {
    const error = new Error('No image provided.');
    error.statusCod = 422;
    return next(error);
  }
  if (!checkImageFileExtension(image.mimetype)) {
    const error = new Error(
      `The format of the image must be png, jpg or jpeg. The file sent is ${image.mimetype}`
    );
    error.statusCode = 422;
    return next(error);
  }
  const name = req.body.name;
  const doNotify = req.body.doNotify == 'true';
  let description = req.body.description;
  if (!description) {
    description = '';
  }
  const userId = req.userId;
  const fileId = `${uuid.v4()}.png`;
  try {
    const imageUrl = await s3UploadFileSync(image.data, fileId, AWS_PEOPLE_BKTNAME);
    const user = await User.findById(userId);
    if (!user) {
      const error = new Error('User not found.');
      error.statusCode = 404;
      throw error;
    }
    const faceRecords = await indexFacesSync(user.collectionId, fileId, AWS_PEOPLE_BKTNAME);
    if (faceRecords.length > 1) {
      const faceIds = faceRecords.map((face) => face.Face.FaceId);
      await deleteFacesFromCollectionSync(user.collectionId, faceIds);
      const error = new Error('Please, only one person per photo.');
      error.statusCode = 422;
      throw error;
    }
    const faceId = faceRecords[0].Face.FaceId;
    const usersPeople = await Person.find({ userId: userId });
    const faceIdExists = usersPeople.find((person) => person.faceId === faceId);
    if (faceIdExists) {
      const error = new Error('This face is already known.');
      error.statusCode = 422;
      throw error;
    }
    const person = new Person({
      name: name,
      description: description,
      imageUrl: imageUrl,
      userId: userId.toString(),
      imageId: fileId,
      faceId: faceId,
      doNotify: doNotify,
    });
    await person.save();
    user.people.push(person);
    await user.save();
    res.status(201).json({
      message: 'Person created successfully.',
      person: {
        _id: person.id,
        name: person.name,
        description: person.description,
        imageUrl: person.imageUrl,
        counter: person.counter,
        doNotify: person.doNotify,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
      },
    });
  } catch (err) {
    await s3DeleteFileSync(fileId, AWS_PEOPLE_BKTNAME);
    return next(err);
  }
};

exports.updatePerson = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new Error('Validation failed.');
    error.statusCode = 422;
    error.errors = errors.array();
    return next(error);
  }
  const personId = req.params.personId;
  const name = req.body.name;
  const description = req.body.description;
  const doNotify = req.body.doNotify;
  const userId = req.userId;
  let isModified = false;
  try {
    const person = await Person.findById(personId);
    if (!person) {
      const error = new Error('Person not found.');
      error.statusCode = 404;
      throw error;
    }
    if (person.userId.toString() !== userId.toString()) {
      const error = new Error('Not authorized. You are not the creator.');
      error.statusCode = 401;
      throw error;
    }
    if (typeof name === 'string') {
      if (name !== person.name) {
        person.name = name;
        isModified = true;
      }
    }
    if (typeof description === 'string') {
      if (description !== person.description) {
        person.description = description;
        isModified = true;
      }
    }
    if (typeof doNotify === 'boolean') {
      if (doNotify != person.doNotify) {
        person.doNotify = doNotify;
        isModified = true;
      }
    }
    let resMessage = 'Nothing changed.';
    if (isModified) {
      resMessage = 'Person updated successfully.';
      await person.save();
    }
    res.status(200).json({
      message: resMessage,
      person: {
        _id: person.id,
        name: person.name,
        description: person.description,
        imageUrl: person.imageUrl,
        counter: person.counter,
        doNotify: person.doNotify,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.deletePerson = async (req, res, next) => {
  const personId = req.params.personId;
  const userId = req.userId;
  try {
    const person = await Person.findById(personId);
    if (!person) {
      const error = new Error('Person not found.');
      error.statusCode = 404;
      throw error;
    }
    if (person.userId.toString() !== userId.toString()) {
      const error = new Error('Not authorized. You are not the creator.');
      error.statusCode = 401;
      throw error;
    }
    const faceId = person.faceId;
    await s3DeleteFileSync(person.imageId, AWS_PEOPLE_BKTNAME);
    await Person.findByIdAndRemove(personId);
    const user = await User.findById(userId);
    const collectionId = user.collectionId;
    user.people.pull(personId);
    await deleteFacesFromCollectionSync(collectionId, [faceId]);
    await user.save();
    res.status(200).json({ message: 'Person deleted.' });
  } catch (error) {
    return next(error);
  }
};

exports.resetCounter = async (req, res, next) => {
  const personId = req.params.personId;
  const userId = req.userId;
  try {
    const person = await Person.findById(personId);
    if (!person) {
      const error = new Error('Person not found.');
      error.statusCode = 404;
      throw error;
    }
    if (person.userId.toString() !== userId.toString()) {
      const error = new Error('Not authorized. You are not the creator.');
      error.statusCode = 401;
      throw error;
    }
    person.counter = 0;
    await person.save();
    res.status(200).json({
      message: 'Counter resetted.',
      person: {
        _id: person.id,
        name: person.name,
        description: person.description,
        imageUrl: person.imageUrl,
        counter: person.counter,
        doNotify: person.doNotify,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
      },
    });
  } catch (err) {
    return next(err);
  }
};
