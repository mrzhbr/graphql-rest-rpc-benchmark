export const FLAT_USERS_QUERY = /* GraphQL */ `
  query FlatUsers($limit: Int!) {
    users(limit: $limit) {
      id
      name
      plan
    }
  }
`;

export const NESTED_FEED_QUERY = /* GraphQL */ `
  query NestedFeed($users: Int!, $posts: Int!, $comments: Int!) {
    users(limit: $users) {
      id
      name
      plan
      posts(limit: $posts) {
        id
        title
        comments(limit: $comments) {
          id
          body
          author {
            id
            name
            plan
          }
        }
      }
    }
  }
`;

export const INTROSPECTION_PROBE = /* GraphQL */ `
  query IntrospectionProbe {
    __schema {
      queryType {
        name
      }
    }
  }
`;
