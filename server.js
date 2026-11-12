import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (!Number.isInteger(priority) || priority < 1) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

const VALID_STATUSES = ['backlog', 'in-progress', 'complete'];

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;

  // Validate the optional inputs before touching the database
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).send({
      'message': 'Invalid status provided.',
      'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
    });
  }
  if (priority !== undefined) {
    const priorityCheck = validatePriority(priority);
    if (!priorityCheck.valid) {
      return res.status(400).send(priorityCheck.messageObj);
    }
  }

  let clients = db.prepare('select * from clients').all();
  const client = clients.find(client => client.id === id);

  /* ---------- Update code below ----------*/

  const targetStatus = status === undefined ? client.status : status;
  const statusChanged = targetStatus !== client.status;

  // Nothing to change: same status and no new priority
  if (!statusChanged && priority === undefined) {
    return res.status(200).send(clients);
  }

  // Clients in a swimlane, ordered by priority, leaving out the client being moved
  const laneWithout = (laneStatus) => clients
    .filter(c => c.status === laneStatus && c.id !== client.id)
    .sort((a, b) => a.priority - b.priority);

  const targetLane = laneWithout(targetStatus);

  // Where does the client go in the target lane? (0-based index)
  // - no priority given: the end of the lane (lowest priority)
  // - priority given: that position, or the end if the number is past the end of the lane
  const insertIndex = priority === undefined
    ? targetLane.length
    : Math.min(priority - 1, targetLane.length);
  targetLane.splice(insertIndex, 0, { ...client, status: targetStatus });

  const updateStatement = db.prepare('update clients set status = ?, priority = ? where id = ?');
  const saveLane = (lane, laneStatus) => {
    // Renumber the lane 1..n so priorities stay unique and contiguous
    lane.forEach((c, index) => updateStatement.run(laneStatus, index + 1, c.id));
  };

  // Do all of the updates together so the database is never left half-changed
  db.transaction(() => {
    saveLane(targetLane, targetStatus);
    if (statusChanged) {
      // Close the gap left behind in the lane the client moved out of
      saveLane(laneWithout(client.status), client.status);
    }
  })();

  clients = db.prepare('select * from clients').all();
  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
