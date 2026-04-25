FROM nginx:latest

# Remove default files
RUN rm -rf /usr/share/nginx/html/*

# CRITICAL: Remove symlinks so logs are written to physical files for mtail
RUN rm /var/log/nginx/access.log /var/log/nginx/error.log

COPY html/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
