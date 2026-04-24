import logger from "./logger.js";

const errorMiddleware = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  if (process.env.NODE_ENV === "development") {
    logger.error(`Error in RAG: ${err.message}`, { stack: err.stack });
    res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      stack: err.stack,
    });
  } else {
    logger.error("RAG SERVICE ERROR 💥", err);
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message || "Internal RAG Service Error",
    });
  }
};

export default errorMiddleware;
