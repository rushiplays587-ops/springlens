package com.shop.web;

import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(NotFoundException.class)
    public ErrorBody handleNotFound(NotFoundException ex) { return new ErrorBody(404, ex.getMessage()); }

    @ExceptionHandler(Exception.class)
    public ErrorBody handleAny(Exception ex) { return new ErrorBody(500, "Unexpected error"); }
}
