const uuid = require("uuid");
const fs = require("fs");
const emoji = require("node-emoji");
const request = require("request-promise-native");

const {
  s3UploadFileSync,
  searchFacesByImage,
  s3DeleteFileSync,
  s3DeleteFilesSync,
} = require("../utils/aws");
const { sendEvent } = require("../utils/telegram-bot");
const { checkImageFileExtension } = require("../utils/fs");
const sendMail = require("../utils/sendgrid");

const User = require("../models/user");
const Event = require("../models/event");
const Person = require("../models/person");
const Raspberry = require("../models/raspberry");

const emailTemplate = fs
  .readFileSync("./email-template/event-created.html")
  .toString();
const AWS_EVENTS_BKTNAME = process.env.AWS_EVENTS_BKTNAME;

exports.createEvent = async (req, res, next) => {
  if (!req.files) {
    const error = new Error("No image provided.");
    error.statusCode = 422;
    return next(error);
  }
  if (!req.files.image) {
    const error = new Error("No image provided.");
    error.statusCode = 422;
    return next(error);
  }
  const image = req.files.image;
  if (!req.raspiId) {
    const error = new Error("Not authorized.");
    error.statusCode = 401;
    return next(error);
  }
  if (!checkImageFileExtension(image.mimetype)) {
    const error = new Error(
      `The format of the image must be png, jpg or jpeg; you sent ${image.mimetype}`
    );
    error.statusCode = 422;
    return next(error);
  }
  const fileId = `${uuid.v4()}.jpg`;
  let eventDescription;
  let isCreated = false;
  try {
    const imageUrl = await s3UploadFileSync(
      image.data,
      fileId,
      AWS_EVENTS_BKTNAME
    );
    const raspberry = await Raspberry.findOne({
      raspiId: req.raspiId.toString(),
    });
    const user = await User.findById(raspberry.userId);
    const searchResult = await searchFacesByImage(
      user.collectionId,
      AWS_EVENTS_BKTNAME,
      image.data
    );
    let newEvent;
    let doNotify = true;
    if (searchResult.code == "NO_FACE_DETECTED") {
      eventDescription = `Something/someone unknown detected.`;
      newEvent = new Event({
        description: eventDescription,
        userId: user._id,
        imageName: fileId,
        imageUrl: imageUrl,
        raspiId: raspberry.raspiId,
      });
    } else if (searchResult.code == "FACE_DETECTED") {
      const person = await Person.findOne({
        faceId: searchResult.data.Face.FaceId,
      });
      if (!person) {
        eventDescription = `An unknown person detected.`;
        newEvent = new Event({
          description: eventDescription,
          userId: user._id,
          imageName: fileId,
          imageUrl: imageUrl,
          raspiId: raspberry.raspiId,
        });
      } else {
        eventDescription = `${
          person.name
        } was found with a ${searchResult.data.Similarity.toFixed(
          2
        )}% of confidence.`;
        newEvent = new Event({
          person: person,
          description: eventDescription,
          userId: user._id,
          imageName: fileId,
          imageUrl: imageUrl,
          raspiId: raspberry.raspiId,
        });
        person.counter++;
        await person.save();
        doNotify = person.doNotify;
      }
    }
    const event = await newEvent.save();
    isCreated = true;
    user.events.push(event);
    await user.save();
    if (doNotify) {
      const warningEmoji = emoji.get("warning");
      const html = renderEmailHtml(
        user.name,
        raspberry.name,
        eventDescription,
        imageUrl
      );
      sendMail(
        user.email,
        `RaspiFace - New Event! ${warningEmoji} ${warningEmoji} ${warningEmoji}`,
        html
      );
      for (telegramId of user.telegramIds) {
        sendEvent(
          `Raspberry: *${raspberry.name}* says:\n\n${eventDescription}`,
          imageUrl,
          telegramId.telegramId
        );
      }
    }
    let eventPerson;
    if (event.person) {
      eventPerson = {
        _id: event.person._id.toString(),
        counter: event.person.counter,
        name: event.person.name,
        description: event.person.description,
      };
    }
    request.post(`${process.env.WS_CONTROLLER_URL}/user/event`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user._id.toString(),
        event: {
          person: eventPerson,
          description: event.description,
          imageUrl: event.imageUrl,
          raspiId: event.raspiId,
          createdAt: new Date(event.createdAt).toISOString(),
          _id: event._id.toString(),
        },
      }),
    });
    res.status(201).json({
      message: "Event created successfully.",
      event: {
        person: eventPerson,
        description: event.description,
        imageUrl: event.imageUrl,
        raspiId: event.raspiId,
        createdAt: new Date(event.createdAt).toISOString(),
        _id: event._id.toString(),
      },
    });
  } catch (error) {
    if (!isCreated) {
      s3DeleteFileSync(fileId, AWS_EVENTS_BKTNAME);
    }
    return next(error);
  }
};

module.exports.getEvent = async (req, res, next) => {
  const eventId = req.params.eventId;
  const userId = req.userId;
  try {
    const event = await Event.findById(eventId).populate("person");
    if (!event) {
      const error = new Error("Event not found.");
      error.statusCode = 404;
      throw error;
    }
    if (event.userId.toString() !== userId.toString()) {
      const error = new Error("You are not the creator.");
      error.statusCode = 401;
      throw error;
    }
    res.status(200).json({
      message: "Success.",
      event: {
        _id: event._id.toString(),
        person: event.person
          ? {
              _id: event.person._id,
              counter: event.person.counter,
              name: event.person.name,
              description: event.person.description,
              imageUrl: event.person.imageUrl,
            }
          : null,
        description: event.description,
        imageUrl: event.imageUrl,
        raspiId: event.raspiId,
        createdAt: new Date(event.createdAt).toISOString(),
      },
    });
  } catch (err) {
    return next(err);
  }
};

module.exports.getEvents = async (req, res, next) => {
  const userId = req.userId;
  const perPage = +req.query.perPage || 10;
  let currentPage = req.query.page || 1;
  try {
    const totalEvents = await Event.find({ userId: userId }).countDocuments();
    /*CHECKS IF THE CURRENT PAGE EXISTS*/
    if (
      perPage * currentPage >
      totalEvents + (perPage - (totalEvents % perPage))
    ) {
      const error = new Error("This page does not exists.");
      error.statusCode = 404;
      throw error;
    }
    const loadedEvents = await Event.find({ userId: userId })
      .skip((currentPage - 1) * perPage)
      .limit(perPage)
      .sort({
        createdAt: -1,
      })
      .populate("person");
    const events = loadedEvents.map((event) => {
      return {
        _id: event._id.toString(),
        person: event.person
          ? {
              _id: event.person._id,
              counter: event.person.counter,
              name: event.person.name,
              description: event.person.description,
              imageUrl: event.person.imageUrl,
            }
          : null,
        description: event.description,
        imageUrl: event.imageUrl,
        raspiId: event.raspiId,
        createdAt: new Date(event.createdAt).toISOString(),
      };
    });
    res
      .status(200)
      .json({ message: "Success.", events: events, totalEvents: totalEvents });
  } catch (err) {
    return next(err);
  }
};

module.exports.deleteEvent = async (req, res, next) => {
  const eventId = req.params.eventId;
  const userId = req.userId;
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      const error = new Error("Event not found.");
      error.statusCode = 404;
      throw error;
    }
    if (event.userId.toString() !== userId.toString()) {
      const error = new Error("You are not the creator.");
      error.statusCode = 401;
      throw error;
    }
    const user = await User.findById(userId);
    user.events.pull(eventId);
    await user.save();
    await s3DeleteFileSync(event.imageName, AWS_EVENTS_BKTNAME);
    await Event.findByIdAndRemove(eventId);
    res.status(201).json({ message: "Event deleted." });
  } catch (err) {
    return next(err);
  }
};

module.exports.deleteEvents = async (req, res, next) => {
  const userId = req.userId;
  try {
    const user = await User.findById(userId);
    const events = await Event.find({ userId: userId });
    if (events.length <= 0) {
      const error = new Error("No events found.");
      error.statusCode = 404;
      throw error;
    }
    const eventsFileNames = [];
    for (let event of events) {
      eventsFileNames.push({ Key: event.imageName });
    }
    await Event.deleteMany({ userId: userId });
    user.events = [];
    await user.save();
    s3DeleteFilesSync(eventsFileNames, AWS_EVENTS_BKTNAME);
    res.status(200).json({ message: "Events deleted." });
  } catch (err) {
    return next(err);
  }
};

const renderEmailHtml = (userName, raspiName, description, imageUrl) => {
  let fileContent = emailTemplate;
  fileContent = fileContent.replace("{{USER_NAME}}", userName);
  fileContent = fileContent.replace("{{RASPI_NAME}}", raspiName);
  fileContent = fileContent.replace("{{DESCRIPTION}}", description);
  fileContent = fileContent.replace("{{IMAGE_URL}}", imageUrl);
  return fileContent;
};
