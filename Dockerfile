# Production image. Build from the repo root with the fmto submodule checked out.
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/viewer .

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /out/viewer /app/viewer
COPY templates /app/templates
COPY assets /app/assets
ENV ADDR=:8080 ASSETS_DIR=/app/assets TEMPLATES_DIR=/app/templates
EXPOSE 8080
ENTRYPOINT ["/app/viewer"]
