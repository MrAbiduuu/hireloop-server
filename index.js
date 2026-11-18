import express, { response } from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(process.env.MONGO_DB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloopdb");
const users = database.collection("user");
const jobs = database.collection("jobs");
const applications = database.collection("applications");
const payments = database.collection("payments");

const app = express();
const port = process.env.PORT || 8000;
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("hireloop is looping");
});

app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/users/:id/premium", async (req, res) => {
  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ premium: false });
  }
  const query = { _id: new ObjectId(id) };
  // `permium` is the legacy field name written before the typo was fixed,
  // so keep reading it to avoid downgrading users who already paid.
  const result = await users.findOne(query, {
    projection: { premium: 1, permium: 1 },
  });
  // Always return a proper JSON body — res.send(null) produced an empty
  // response that made the client's response.json() throw.
  res.send({ premium: Boolean(result?.premium || result?.permium) });
});

// JOBS RELATED API
app.get("/jobs", async (req, res) => {
  const query = {};
  if (req.query) {
    if (req.query.jobType) {
      query.jobType = req.query.jobType;
    }
    if (req.query.isRemote) {
      query.isRemote = req.query.isRemote === "true";
    }
    if (req.query.jobCategory) {
      query.jobCategory = req.query.jobCategory;
    }
    if (req.query.search) {
      query.$or = [
        {
          jobTitle: { $regex: req.query.search, $options: "i" },
        },
        {
          companyName: { $regex: req.query.search, $options: "i" },
        },
        {
          responsibilities: { $regex: req.query.search, $options: "i" },
        },
        {
          qualifications: {
            $regex: req.query.search,
            $options: "i",
          },
        },
      ];
    }
  }
  const cursor = jobs.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.post("/jobs", async (req, res) => {
  const result = await jobs.insertOne(req.body);
  res.send(result);
});

// Get a single job by its id (used by the job details page)
app.get("/jobs/:id", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid job id" });
  }

  const job = await jobs.findOne({ _id: new ObjectId(id) });

  if (!job) {
    return res.status(404).send({ message: "Job not found" });
  }

  res.send(job);
});

// APPLICATION RELATED API

// Check whether a user has already applied to a job (used by the job
// details page so the "Apply" button reflects the real state on load)
app.get("/applications/check", async (req, res) => {
  const { jobId, userId } = req.query;

  if (!jobId || !userId) {
    return res.status(400).send({ message: "jobId and userId are required" });
  }

  const existing = await applications.findOne({ jobId, userId });
  res.send({ applied: Boolean(existing) });
});

// List applications, optionally filtered by ?userId= and/or ?jobId=
app.get("/applications", async (req, res) => {
  const query = {};
  if (req.query.userId) query.userId = req.query.userId;
  if (req.query.jobId) query.jobId = req.query.jobId;

  // Newest first for the "My Applications" table
  const result = await applications
    .find(query)
    .sort({ appliedAt: -1 })
    .toArray();
  res.send(result);
});
app.get("/applications/count", async (req, res) => {
  const query = {};
  if (req.query.userId) query.userId = req.query.userId;
  if (req.query.jobId) query.jobId = req.query.jobId;

  const result = await applications.countDocuments(query);
  res.send({ count: result });
});

// Remove an application (seeker withdrawing their application)
app.delete("/applications/:id", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid application id" });
  }

  const result = await applications.deleteOne({ _id: new ObjectId(id) });

  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Application not found" });
  }

  res.send(result);
});

app.post("/applications", async (req, res) => {
  const application = req.body;

  // Basic validation
  if (!application.jobId || !application.userId) {
    return res.status(400).send({ message: "jobId and userId are required" });
  }

  // One application per user per job
  const existing = await applications.findOne({
    jobId: application.jobId,
    userId: application.userId,
  });
  if (existing) {
    return res
      .status(409)
      .send({ message: "You have already applied to this job" });
  }

  // Mongo creates the "applications" collection automatically on first insert
  const result = await applications.insertOne({
    ...application,
    status: "pending",
    appliedAt: new Date(),
  });

  res.status(201).send(result);
});

app.delete("/jobs/:id", async (req, res) => {
  const id = req.params.id;
  const result = await jobs.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
});

// payments related api
app.post("/payments/checkout-verify", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.send({ success: false, message: "Session Id is required" });
  }

  const { status, payment_status, customer_email, metadata, payment_intent } =
    await stripe.checkout.sessions.retrieve(sessionId);
  if (status === "complete" && payment_status === "paid") {
    const sessionQuery = { sessionId };
    const esixtingPayment = await payments.findOne(sessionQuery);
    if (esixtingPayment) {
      return res.send({ success: false, message: "Payment already verified" });
    }

    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email,
      useId: metadata.userId,
      payment_date: new Date(),
      payment_intent,
    };
    const result = await payments.insertOne(payment);

    const query = { _id: new ObjectId(metadata.userId) };

    const updatedDoc = {
      $set: {
        premium: true,
      },
    };
    const updatedResult = await users.updateOne(query, updatedDoc);
    return res.send({ success: true, result, updatedResult });
  }
  res.send({ success: false, message: "Payment Verification Failed" });
});

app.listen(port, () => {
  console.log(`hireloop server listening on port ${port}`);
});
