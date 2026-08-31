// backend/src/ports/PrintQueuePort.js

/**
 * Outbound channel towards the hardware node on the RPi 4.
 *
 * The backend never talks to a printer: it publishes a job and later receives the
 * outcome. Any transport (WebSocket, MQTT) is an adapter behind this contract.
 *
 * @typedef {object} PrintTicket
 * @property {string} jobId
 * @property {string} text
 * @property {string} attribution rendered credit line, author and printer already merged
 * @property {boolean} includesVideo
 *
 * @typedef {object} PrintQueuePort
 * @property {(ticket: PrintTicket) => Promise<void>} publish
 * @property {() => Promise<boolean>} isHardwareOnline
 */

export {};
