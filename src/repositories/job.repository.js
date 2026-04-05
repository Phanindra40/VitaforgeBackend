const mongoose = require("mongoose");
const Job = require("../models/Job");

const fallbackJobs = [
  {
    id: "job-1",
    title: "Backend Node.js Developer",
    description: "Build REST APIs using Node.js, Express, MongoDB, Docker, and AWS.",
  },
  {
    id: "job-2",
    title: "Full Stack JavaScript Engineer",
    description: "Develop React and Node.js apps, write tests, and manage CI/CD pipelines.",
  },
  {
    id: "job-3",
    title: "Platform Engineer",
    description: "Work with Kubernetes, microservices, observability, and scalable cloud architecture.",
  },
];

async function getAllJobs() {
  if (mongoose.connection.readyState !== 1) {
    return fallbackJobs;
  }

  const dbJobs = await Job.find({}).lean();
  return dbJobs.length ? dbJobs : fallbackJobs;
}

module.exports = { getAllJobs };
