export declare class AppError extends Error {
    statusCode: number;
    constructor(message: string, statusCode?: number);
}
